// ─────────────────────────────────────────────
// Sentinel — Projects API
// ─────────────────────────────────────────────

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';
import { ValidationError } from '../../core/errors.js';

export function createProjectRoutes(services) {
  const router = Router();

  // GET /api/projects/:id/stats — Project-level stats
  router.get('/:id/stats', asyncHandler(async (req, res) => {
    const projectId = req.params.id;
    if (!projectId?.trim()) throw new ValidationError('projectId is required');

    const [sessions, findings] = await Promise.all([
      services.sessions.list(projectId, { limit: 1000, offset: 0 }),
      services.findings.listByProject(projectId, { limit: 1000, offset: 0 }),
    ]);

    const stats = {
      projectId,
      totalSessions: sessions.length,
      activeSessions: sessions.filter(s => s.status === 'active').length,
      totalFindings: findings.length,
      byStatus: {},
      bySeverity: {},
      byType: {},
    };

    for (const f of findings) {
      stats.byStatus[f.status] = (stats.byStatus[f.status] || 0) + 1;
      if (f.severity) stats.bySeverity[f.severity] = (stats.bySeverity[f.severity] || 0) + 1;
      if (f.type) stats.byType[f.type] = (stats.byType[f.type] || 0) + 1;
    }

    res.json({ success: true, data: stats });
  }));

  return router;
}
