FORGE ERP, PORTABLE

No installer. Unzip this folder anywhere you like, then:

  Windows   Double-click "Start Forge (Windows).bat"
  Mac       Right-click "Start Forge (Mac).command", choose Open, then Open again.
            (Mac asks this once, because the file is not signed.)

The first start downloads Node.js and MongoDB into this folder, checked against the
checksums their makers publish. Windows: about 650 MB. Mac: about 120 MB. Keep the computer
online for that first start. It also asks Windows for permission once, to add the
Visual C++ runtime that MongoDB needs.

Forge then opens in your browser at http://localhost:4100
Your sign-in is shown in the window, and kept in data/sign-in.txt
Change the password after signing in.

Keep the window open while you use Forge. Close it to stop Forge.
Your data and daily backups are in the data folder. Copy that folder to keep them safe.
