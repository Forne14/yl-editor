import type { AtomDefinition, Catalogue, RoleDefinition } from "./catalogue.ts";

/** One host's catalogue, used as a fixture. The engine knows nothing about it. */
const atom = (name: string, label: string): AtomDefinition => ({ atom: name, label, family: name.split(".")[0]! });

export const fixtureAtoms: AtomDefinition[] = [
  atom("posts.write.own", "Write and edit their own posts"),
  atom("posts.write.any", "Edit anyone's posts"),
  atom("posts.publish", "Publish, schedule and unpublish posts"),
  atom("pages.edit", "Change page copy as a draft"),
  atom("pages.publish", "Put page changes live"),
  atom("newsletter.write", "Write newsletter issues"),
  atom("newsletter.send", "Send and schedule newsletter issues"),
  atom("subscribers.read", "See the subscriber list"),
  atom("subscribers.export", "Export subscribers"),
  atom("shop.manage", "Change the product and shop settings"),
  atom("orders.fulfil", "Mark orders shipped and refund"),
  atom("radio.manage", "Run the station"),
  atom("radio.password.own", "See their own stream password"),
  atom("chat.moderate", "Moderate the live chat"),
  atom("media.manage", "Manage the media library"),
  atom("people.invite", "Invite people"),
  atom("people.manage", "Change roles, disable and remove people"),
  atom("roles.manage", "Create and edit custom roles"),
  atom("activity.read", "See the activity log"),
  atom("owner.transfer", "Transfer ownership"),
];

const role = (id: string, label: string, atoms: string[]): RoleDefinition => ({
  id,
  label,
  line: `${label} line`,
  atoms,
  builtin: true,
});

export const fixtureRoles: RoleDefinition[] = [
  role("owner", "Owner", ["*"]),
  role("admin", "Admin", ["*"]),
  role("editor", "Editor", ["posts.*", "pages.*", "media.manage", "newsletter.*", "subscribers.read", "chat.moderate"]),
  role("contributor", "Contributor", ["posts.write.own", "media.manage", "chat.moderate"]),
  role("radio_desk", "Radio desk", ["radio.*", "chat.moderate", "media.manage"]),
  role("shop", "Shop", ["shop.manage", "orders.fulfil"]),
  role("dj", "DJ", ["radio.password.own", "chat.moderate", "posts.write.own"]),
];

export function fixtureCatalogue(): Catalogue {
  return structuredClone({
    atoms: fixtureAtoms,
    ownerReserved: ["owner.transfer"],
    ownerRoleId: "owner",
    roles: fixtureRoles,
  });
}

export function customRole(id: string, atoms: string[]): RoleDefinition {
  return { id, label: id, line: "", atoms, builtin: false };
}
