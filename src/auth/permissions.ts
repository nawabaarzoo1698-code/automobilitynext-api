// The permission catalog. A role holds "module:action" strings; "*" is all.
// Modules follow the CMS sidebar so the Roles screen can show them as a tree.

export const ACTIONS = ["view", "create", "edit", "publish", "delete"] as const;
export type Action = (typeof ACTIONS)[number];

export const MODULES = {
  dashboard: { section: "Analysis & Reports", label: "Dashboard", actions: ["view"] },
  reports: { section: "Analysis & Reports", label: "Reports", actions: ["view"] },
  articles: { section: "Newsroom", label: "News & Articles", actions: ["view", "create", "edit", "publish", "delete"] },
  categories: { section: "Newsroom", label: "Categories", actions: ["view", "create", "edit", "delete"] },
  tags: { section: "Newsroom", label: "Tags", actions: ["view", "create", "edit", "delete"] },
  writers: { section: "Newsroom", label: "Writers", actions: ["view", "create", "edit", "delete"] },
  topics: { section: "Newsroom", label: "Topics and Topic Types", actions: ["view", "create", "edit", "delete"] },
  webmaster: { section: "Newsroom", label: "Menus, Pages, Regions, Static Content", actions: ["view", "create", "edit", "delete"] },
  media: { section: "Library", label: "Media", actions: ["view", "create", "edit", "delete"] },
  seo: { section: "Performance", label: "SEO", actions: ["view", "edit"] },
  subscribers: { section: "Performance", label: "Newsletter Subscribers", actions: ["view", "create", "edit", "delete"] },
  users: { section: "Settings", label: "Users", actions: ["view", "create", "edit", "delete"] },
  roles: { section: "Settings", label: "Roles", actions: ["view", "create", "edit", "delete"] },
  settings: { section: "Settings", label: "Global Settings", actions: ["view", "edit"] },
  logs: { section: "Settings", label: "Logs", actions: ["view"] },
  grievances: { section: "Settings", label: "Grievances", actions: ["view", "edit"] },
} as const satisfies Record<string, { section: string; label: string; actions: readonly Action[] }>;

export type ModuleKey = keyof typeof MODULES;
export type Permission = `${ModuleKey}:${Action}` | "*";

export const ALL_PERMISSIONS: string[] = Object.entries(MODULES).flatMap(([m, def]) =>
  def.actions.map((a) => `${m}:${a}`),
);

export function isKnownPermission(p: string) {
  return p === "*" || ALL_PERMISSIONS.includes(p);
}

export function can(granted: readonly string[], module: ModuleKey, action: Action) {
  return granted.includes("*") || granted.includes(`${module}:${action}`);
}
