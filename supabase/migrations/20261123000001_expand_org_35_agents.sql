begin;

insert into public.nh_org_agents (agent_id, display_name, team_id, role, is_manager, manager_agent_id, responsibilities, channels, individual_learning_file)
values
  (
    'dx-context-wording-specialist',
    'Context & Content Wording Specialist',
    'business-dx',
    'Contextual Copy, Tone & Bilingual Messaging Architect',
    false,
    'dx-manager',
    '["Tailor English and Thai wording to each customer context, channel, and user intent","Eliminate robotic phrasing and align tone across LINE Flex Cards, web trial flows, and Notion playbooks","Maintain consistent terminology for Neurohands hardware, governance, and industry verticals"]'::jsonb,
    '["web","line_user","notion"]'::jsonb,
    'platform/docs/org/learning/individual/dx-context-wording-specialist.jsonl'
  ),
  (
    'web-ux-device-tester',
    'Customer Multi-Device UX Tester',
    'website-brand-ux',
    'Phone, Tablet & Laptop Customer UX QA Specialist',
    false,
    'web-manager',
    '["Audit customer journeys and tap/click ergonomics across 390px phone, 768px tablet, and 1440px laptop viewports","Verify zero horizontal overflow, unclipped anchor jumps (#trial-workspace), and responsive LINE-to-web handoffs","Catch layout regressions, modal overlap, and mobile dark-mode readability issues before release"]'::jsonb,
    '["web","line_user"]'::jsonb,
    'platform/docs/org/learning/individual/web-ux-device-tester.jsonl'
  ),
  (
    'web-color-sync-designer',
    'Synchronized UI Color Designer',
    'website-brand-ux',
    'Cross-Surface Brand Palette & Token Synchronization Specialist',
    false,
    'web-manager',
    '["Synchronize Midnight Navy (#060D28), Electric Cyan (#0F8CE8/#38BDF8), and Crisp White tokens across /neurohands, Studio, LINE Rich Menus, Flex Cards, and visual guides","Verify WCAG AA contrast compliance and forced-dark-mode color immunity across iOS, Android, and desktop browsers","Eliminate mismatched surface backgrounds, border contrast drift, and unaligned palette accents"]'::jsonb,
    '["web","line_user"]'::jsonb,
    'platform/docs/org/learning/individual/web-color-sync-designer.jsonl'
  )
on conflict (agent_id) do nothing;

commit;
