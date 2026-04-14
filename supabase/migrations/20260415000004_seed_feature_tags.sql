-- Seed the canonical 30-slug feature tag enum. Source of truth in
-- lib/pipeline/scoring/seed-feature-tags.ts — keep in sync.
--
-- ON CONFLICT ... DO UPDATE handles the edge case where sub-project #2's
-- discover job may have inserted one of these slugs with kind='tech_stack'.
-- This migration promotes them to kind='feature' if they were wrong-kinded.

INSERT INTO public.tags (slug, kind, label) VALUES
  ('auth',                  'feature', 'Authentication'),
  ('social_login',          'feature', 'Social Login'),
  ('magic_link',            'feature', 'Magic Link'),
  ('payments',              'feature', 'Payments'),
  ('stripe',                'feature', 'Stripe'),
  ('subscription',          'feature', 'Subscription'),
  ('dark_mode',             'feature', 'Dark Mode'),
  ('responsive',            'feature', 'Responsive'),
  ('animation',             'feature', 'Animation'),
  ('ai_integration',        'feature', 'AI Integration'),
  ('chatbot',               'feature', 'Chatbot'),
  ('rag',                   'feature', 'RAG'),
  ('database_included',     'feature', 'Database Included'),
  ('realtime',              'feature', 'Realtime'),
  ('docker',                'feature', 'Docker'),
  ('ci_cd',                 'feature', 'CI/CD'),
  ('self_hostable',         'feature', 'Self-hostable'),
  ('mdx',                   'feature', 'MDX'),
  ('cms',                   'feature', 'CMS'),
  ('blog_content',          'feature', 'Blog Content'),
  ('email',                 'feature', 'Email'),
  ('transactional_email',   'feature', 'Transactional Email'),
  ('analytics',             'feature', 'Analytics'),
  ('seo',                   'feature', 'SEO'),
  ('sitemap',               'feature', 'Sitemap'),
  ('i18n',                  'feature', 'i18n'),
  ('rtl',                   'feature', 'RTL'),
  ('file_upload',           'feature', 'File Upload'),
  ('search',                'feature', 'Search'),
  ('notifications',         'feature', 'Notifications')
ON CONFLICT (slug) DO UPDATE
  SET kind = 'feature', label = EXCLUDED.label
  WHERE public.tags.kind <> 'feature';
