// Order journeys: where each machine order is, what is late, and what waits on whom.
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireObjectId, requirePerm } from '../middleware/index.js';
import { actOnStep, board, journeyFor, waitingOn } from '../services/journeyService.js';

const ok = (res, data) => res.json({ success: true, data });

export function journeyRoutes() {
  const r = Router();
  r.param('buildId', requireObjectId);
  r.use(authenticate, requirePerm('builds.read'));
  r.get('/board', async (req, res) => ok(res, await board({ includeClosed: req.query.closed === 'true' })));
  r.get('/mine', async (req, res) => ok(res, await waitingOn(req.user.role)));
  r.get('/:buildId', async (req, res) => ok(res, await journeyFor(req.params.buildId)));
  r.post('/:buildId/steps/:key', async (req, res) => {
    const body = z.object({
      action: z.enum(['done', 'undo', 'skip', 'plan']),
      note: z.string().trim().max(1000).optional(),
      plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).strict().parse(req.body ?? {});
    ok(res, await actOnStep(req.params.buildId, req.params.key, req.user, body));
  });
  return r;
}
