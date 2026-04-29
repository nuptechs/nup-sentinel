// ─────────────────────────────────────────────
// Sentinel — Project CRUD API (multi-tenant)
//
// CRUD for `sentinel_projects` (a project = a repo / app analyzed by the
// Sentinel pipelines). Scoped to the request's tenant (req.organizationId,
// set by the OIDC auth middleware).
//
// Vertical permission gate: `sentinel.projects.{read,write,manage}`.
// Horizontal membership: routes scoped to /:projectId/* go through
// `requireProjectMembership` (Identify ReBAC).
//
// Refs: ADR 0003.
// ─────────────────────────────────────────────

import { Router } from 'express';
import { Project } from '../../core/domain/project.js';
import { asyncHandler } from '../middleware/error-handler.js';
import { ValidationError, NotFoundError } from '../../core/errors.js';
import { requirePermission } from '../middleware/oidc-auth.js';

function slugify(input) {
  return String(input)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function createProjectCrudRoutes({ projectStorage, identifyClient }) {
  const router = Router();

  // POST /api/projects — create a project in the caller's organization.
  router.post(
    '/',
    requirePermission('sentinel.projects.write', { identifyClient }),
    asyncHandler(async (req, res) => {
      if (!req.organizationId) throw new ValidationError('tenant context missing');
      const { name, slug: slugIn, repoUrl, defaultBranch, description, settings } = req.body || {};
      if (!name?.trim()) throw new ValidationError('name is required');

      const slug = slugify(slugIn || name);
      if (!slug) throw new ValidationError('slug could not be derived from name');

      const project = new Project({
        organizationId: req.organizationId,
        name: name.trim(),
        slug,
        repoUrl: repoUrl || null,
        defaultBranch: defaultBranch || 'main',
        description: description || null,
        settings: settings || {},
      });

      try {
        await projectStorage.createProject(project);
      } catch (err) {
        if (err.code === 'duplicate_slug') {
          return res.status(409).json({ success: false, error: 'duplicate_slug', message: err.message });
        }
        throw err;
      }

      // Auto-grant the creator membership (so `requireProjectMembership` lets
      // them through). Best-effort — failure here only logs; admin can add
      // membership manually via POST /api/projects/:id/members.
      let warning = null;
      if (identifyClient && req.user?.id && req.accessToken) {
        try {
          await identifyClient.addProjectMember({
            accessToken: req.accessToken,
            userId: req.user.id,
            projectId: project.id,
            organizationId: req.organizationId,
          });
        } catch (err) {
          warning = `creator auto-membership failed: ${err?.message || 'unknown'}`;
        }
      }

      res.status(201).json({ success: true, data: project.toJSON(), ...(warning ? { warning } : {}) });
    }),
  );

  // GET /api/projects — list the caller's projects.
  router.get(
    '/',
    requirePermission('sentinel.projects.read', { identifyClient }),
    asyncHandler(async (req, res) => {
      if (!req.organizationId) throw new ValidationError('tenant context missing');
      const { status, limit, offset } = req.query;
      const projects = await projectStorage.listProjects(req.organizationId, {
        status: status || undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      res.json({ success: true, data: projects.map((p) => p.toJSON()) });
    }),
  );

  // GET /api/projects/:projectId
  router.get(
    '/:projectId',
    requirePermission('sentinel.projects.read', { identifyClient }),
    asyncHandler(async (req, res) => {
      const project = await projectStorage.getProject(req.organizationId, req.params.projectId);
      if (!project) throw new NotFoundError(`project not found: ${req.params.projectId}`);
      res.json({ success: true, data: project.toJSON() });
    }),
  );

  // PATCH /api/projects/:projectId
  router.patch(
    '/:projectId',
    requirePermission('sentinel.projects.write', { identifyClient }),
    asyncHandler(async (req, res) => {
      const project = await projectStorage.getProject(req.organizationId, req.params.projectId);
      if (!project) throw new NotFoundError(`project not found: ${req.params.projectId}`);

      const allowed = ['name', 'repoUrl', 'defaultBranch', 'description', 'status', 'settings'];
      for (const k of allowed) {
        if (k in (req.body || {})) project[k] = req.body[k];
      }
      const updated = await projectStorage.updateProject(project);
      if (!updated) throw new NotFoundError(`project not found on update: ${req.params.projectId}`);
      res.json({ success: true, data: updated.toJSON() });
    }),
  );

  // DELETE /api/projects/:projectId
  router.delete(
    '/:projectId',
    requirePermission('sentinel.projects.manage', { identifyClient }),
    asyncHandler(async (req, res) => {
      const ok = await projectStorage.deleteProject(req.organizationId, req.params.projectId);
      if (!ok) throw new NotFoundError(`project not found: ${req.params.projectId}`);
      res.status(204).send();
    }),
  );

  return router;
}
