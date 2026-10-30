import { z } from 'zod';
import {
  allowsBindings,
  frameworks,
  hasImportAdapter,
  usesContainers,
} from './catalog';
export { projectNameFrom } from './names';

export const projectSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(3, 'Use at least 3 characters.')
      .max(48, 'Use at most 48 characters.')
      .regex(
        /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
        'Use lowercase letters, numbers, and single hyphens; start with a letter.',
      ),
    framework: z.enum(frameworks.map((f) => f.id)),
    // A project starts from a starter kit or from a GitHub repository, never both. Without
    // a source, a repository means GitHub.
    source: z.enum(['kit', 'github']).optional(),
    repository: z
      .string()
      .trim()
      .max(200)
      .default('')
      .refine(
        (value) =>
          !value ||
          /^https:\/\/github\.com\/[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+(?:\.git)?\/?$/.test(
            value,
          ),
        'Use a GitHub repository URL, such as https://github.com/owner/repo.',
      ),
    database: z.boolean().default(false),
    storage: z.boolean().default(false),
    freeOnly: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.source === 'github' && !value.repository)
      ctx.addIssue({
        code: 'custom',
        message: 'Choose a GitHub repository for this project.',
        path: ['repository'],
      });
    if (value.source === 'kit' && value.repository)
      ctx.addIssue({
        code: 'custom',
        message:
          'A starter kit project starts without a repository. Push the kit to GitHub, then choose it in Deployments.',
        path: ['repository'],
      });
    if (
      (value.source ?? (value.repository ? 'github' : 'kit')) === 'github' &&
      !hasImportAdapter(value.framework)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'This runtime can’t be deployed from a GitHub repository yet. Save it as a plan instead.',
        path: ['framework'],
      });
    if (value.freeOnly && value.storage)
      ctx.addIssue({
        code: 'custom',
        message:
          'R2 file storage can bill beyond its free tier. Turn off Free-only to add it.',
        path: ['storage'],
      });
    if (value.freeOnly && usesContainers(value.framework))
      ctx.addIssue({
        code: 'custom',
        message:
          'Containers need Cloudflare’s Workers Paid plan. Turn off Free-only to use them.',
        path: ['freeOnly'],
      });
    if (!allowsBindings(value.framework) && (value.database || value.storage)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Resource bindings are available for the React, Vue, Hono, and JavaScript starter kits.',
        path: ['framework'],
      });
    }
  })
  .transform((value) => ({
    ...value,
    source: value.source ?? (value.repository ? 'github' : 'kit'),
  }));
