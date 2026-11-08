// A small POP3 client. POP3 is enough to read a mailbox, and needs no extra packages.
// It only speaks over TLS with a verified certificate, unless a test hands it a socket.
import tls from 'node:tls';

const TIMEOUT_MS = 30000;

export class Pop3Client {
  constructor({ host, port = 995, connect = null }) {
    this.host = host;
    this.port = port;
    this.connectFn = connect;
    this.buffer = Buffer.alloc(0);
    this.waiting = null;
  }

  async open() {
    this.socket = this.connectFn
      ? await this.connectFn()
      : tls.connect({ host: this.host, port: this.port, servername: this.host, rejectUnauthorized: true });
    this.socket.setTimeout?.(TIMEOUT_MS, () => this.socket.destroy(new Error('The mail server stopped answering.')));
    this.socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    this.socket.on('error', (error) => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('The mail server closed the connection.')));
    await this.readLine();
  }

  fail(error) {
    this.closedWith = error;
    if (this.waiting) {
      const { reject } = this.waiting;
      this.waiting = null;
      reject(error);
    }
  }

  // Resolves as soon as the buffer holds what the current read is waiting for.
  pump() {
    if (!this.waiting) return;
    const { terminator, resolve, reject, checkOk } = this.waiting;
    const at = this.buffer.indexOf(terminator);
    if (at < 0) {
      // A multi-line reply that starts with -ERR ends at its first line, not at the dot.
      const firstEnd = this.buffer.indexOf('\r\n');
      if (checkOk && firstEnd >= 0 && this.buffer.toString('latin1', 0, 4) === '-ERR') {
        const line = this.buffer.toString('latin1', 0, firstEnd);
        this.buffer = this.buffer.subarray(firstEnd + 2);
        this.waiting = null;
        reject(new Error(`Mail server: ${line}`));
      }
      return;
    }
    const data = this.buffer.subarray(0, at);
    this.buffer = this.buffer.subarray(at + terminator.length);
    this.waiting = null;
    const firstEnd = data.indexOf('\r\n');
    const firstLine = data.toString('latin1', 0, firstEnd < 0 ? data.length : firstEnd);
    if (!firstLine.startsWith('+OK')) reject(new Error(`Mail server: ${firstLine}`));
    else resolve({ firstLine, rest: firstEnd < 0 ? Buffer.alloc(0) : data.subarray(firstEnd + 2) });
  }

  read(terminator, checkOk = false) {
    return new Promise((resolve, reject) => {
      if (this.closedWith) {
        reject(this.closedWith);
        return;
      }
      this.waiting = { terminator, resolve, reject, checkOk };
      this.pump();
    });
  }

  readLine() {
    return this.read('\r\n');
  }

  async command(text) {
    this.socket.write(`${text}\r\n`);
    return this.readLine();
  }

  async multiline(text) {
    this.socket.write(`${text}\r\n`);
    const { firstLine, rest } = await this.read('\r\n.\r\n', true);
    return { firstLine, rest };
  }

  async login(user, password) {
    await this.command(`USER ${user}`);
    await this.command(`PASS ${password}`);
  }

  // Message number and the server's lasting id for it.
  async list() {
    const { rest } = await this.multiline('UIDL');
    return rest.toString('latin1').split('\r\n').filter(Boolean).map((line) => {
      const [number, uid] = line.split(' ');
      return { number: Number(number), uid };
    });
  }

  async retrieve(number) {
    const { rest } = await this.multiline(`RETR ${number}`);
    // A line starting with a dot had another dot put in front of it to send it.
    return rest.toString('latin1').split('\r\n').map((line) => (line.startsWith('..') ? line.slice(1) : line)).join('\r\n');
  }

  async remove(number) {
    await this.command(`DELE ${number}`);
  }

  async close() {
    try {
      await this.command('QUIT');
    } catch {
      // Already gone, which is all that was wanted.
    }
    this.socket.destroy();
  }
}
