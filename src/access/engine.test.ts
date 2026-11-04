import { describe, expect, test } from "vitest";
import { ALL, createAccessEngine, RoleError } from "./index.ts";
import { customRole, fixtureCatalogue, fixtureRoles } from "./test-fixture.ts";

const engine = createAccessEngine(fixtureCatalogue());
const atomsOf = (roleId: string) => engine.atomsOfRole(roleId);
const owner = atomsOf("owner");
const admin = atomsOf("admin");
const editor = atomsOf("editor");
const contributor = atomsOf("contributor");
const radioDesk = atomsOf("radio_desk");
const dj = atomsOf("dj");
const denied = (reason: string) => ({ allowed: false, reason });
const allowed = { allowed: true };

describe("atomsOfRole", () => {
  test("the owner holds * and therefore the reserved atom", () => {
    expect(owner).toEqual(new Set([ALL]));
    expect(engine.can(owner, "owner.transfer")).toBe(true);
  });
  test("admin is * minus the owner-reserved set", () => {
    expect(admin.has(ALL)).toBe(false);
    expect(engine.can(admin, "owner.transfer")).toBe(false);
    expect(engine.can(admin, "owner.*")).toBe(false);
    for (const definition of engine.catalogue.atoms) {
      if (definition.atom !== "owner.transfer") expect(engine.can(admin, definition.atom), definition.atom).toBe(true);
    }
  });
  test("admin keeps family wildcards, so a future atom in a known family is picked up", () =>
    expect(engine.can(admin, "radio.schedule")).toBe(true));
  test("a custom role holding * is admin-shaped, never owner-shaped", () =>
    expect(engine.atomsOfRole(customRole("everything", [ALL]))).toEqual(admin));
  test("a custom role naming a reserved atom has it stripped", () =>
    expect(engine.atomsOfRole(customRole("sneaky", ["owner.transfer", "posts.publish"]))).toEqual(new Set(["posts.publish"])));
  test("a custom role naming owner.* gains nothing", () =>
    expect(engine.atomsOfRole(customRole("sneaky", ["owner.*"]))).toEqual(new Set()));
  test("stale and malformed atoms in a stored custom role are dropped", () =>
    expect(engine.atomsOfRole(customRole("old", ["posts.delete", "nope", "radio.*"]))).toEqual(new Set(["radio.*"])));
  test("an unknown role id throws", () => expect(() => engine.atomsOfRole("superuser")).toThrow(RoleError));
  test("a custom role cannot reuse the owner's id to gain the reserved set", () =>
    expect(() => engine.atomsOfRole(customRole("owner", ["posts.publish"]))).toThrow(RoleError));
  test("expand keeps wildcards as members", () =>
    expect(engine.expand(["radio.*", "posts.publish", "radio.*"])).toEqual(new Set(["radio.*", "posts.publish"])));
});

describe("covers", () => {
  test("family.* is covered only by family.* or *", () => {
    expect(engine.covers(new Set(["radio.manage", "radio.password.own"]), ["radio.*"])).toBe(false);
    expect(engine.covers(new Set(["radio.*"]), ["radio.*"])).toBe(true);
    expect(engine.covers(owner, ["radio.*"])).toBe(true);
  });
  test("* is covered only by *", () => {
    expect(engine.covers(admin, [ALL])).toBe(false);
    expect(engine.covers(owner, [ALL])).toBe(true);
  });
  test("the empty set is always covered", () => expect(engine.covers(new Set(), [])).toBe(true));
});

describe("canAssignRole: atoms(role) ⊆ actor", () => {
  test("admin cannot assign owner", () => expect(engine.canAssignRole(admin, "owner")).toEqual(denied("missing *")));
  test("admin can assign admin", () => expect(engine.canAssignRole(admin, "admin")).toEqual(allowed));
  test("editor cannot assign admin", () => expect(engine.canAssignRole(editor, "admin").allowed).toBe(false));
  test("contributor cannot assign editor", () =>
    expect(engine.canAssignRole(contributor, "editor")).toEqual(denied("missing posts.*")));
  test("editor cannot assign radio desk", () =>
    expect(engine.canAssignRole(editor, "radio_desk")).toEqual(denied("missing radio.*")));
  test("radio desk can assign dj only if it holds posts.write.own", () =>
    expect(engine.canAssignRole(radioDesk, "dj")).toEqual(denied("missing posts.write.own")));
  test("editor can assign contributor", () => expect(engine.canAssignRole(editor, "contributor")).toEqual(allowed));
  test("a custom role definition can be assigned", () =>
    expect(engine.canAssignRole(radioDesk, customRole("mixer", ["radio.manage", "chat.moderate"]))).toEqual(allowed));
  test("nobody assigns an unknown role", () => expect(() => engine.canAssignRole(owner, "ghost")).toThrow(RoleError));

  test("property: for every pair of roles, assignment is exactly coverage", () => {
    for (const actorRole of fixtureRoles) {
      for (const targetRole of fixtureRoles) {
        const actor = atomsOf(actorRole.id);
        const target = atomsOf(targetRole.id);
        expect(engine.canAssignRole(actor, targetRole.id).allowed, `${actorRole.id} -> ${targetRole.id}`).toBe(
          engine.covers(actor, target),
        );
      }
    }
  });
  test("property: every role can assign itself, and only owner can assign owner", () => {
    for (const actorRole of fixtureRoles) {
      expect(engine.canAssignRole(atomsOf(actorRole.id), actorRole.id).allowed).toBe(true);
      expect(engine.canAssignRole(atomsOf(actorRole.id), "owner").allowed).toBe(actorRole.id === "owner");
    }
  });
});

describe("canAuthorRole", () => {
  test("nobody authors a role containing an atom they lack", () => {
    expect(engine.canAuthorRole(editor, ["posts.publish", "radio.manage"])).toEqual(denied("missing radio.manage"));
    expect(engine.canAuthorRole(contributor, ["posts.write.any"])).toEqual(denied("missing posts.write.any"));
  });
  test("nobody authors a role with a reserved atom, not even the owner", () => {
    expect(engine.canAuthorRole(owner, ["owner.transfer"])).toEqual(denied("owner.transfer is reserved for the owner"));
    expect(engine.canAuthorRole(admin, ["owner.transfer"])).toEqual(denied("owner.transfer is reserved for the owner"));
  });
  test("a custom role holding radio.* needs radio.* or *", () => {
    expect(engine.canAuthorRole(radioDesk, ["radio.*"])).toEqual(allowed);
    expect(engine.canAuthorRole(owner, ["radio.*"])).toEqual(allowed);
    expect(engine.canAuthorRole(admin, ["radio.*"])).toEqual(allowed);
    expect(engine.canAuthorRole(new Set(["radio.manage", "radio.password.own"]), ["radio.*"])).toEqual(
      denied("missing radio.*"),
    );
  });
  test("only the owner authors a role holding *", () => {
    expect(engine.canAuthorRole(admin, [ALL])).toEqual(denied("missing *"));
    expect(engine.canAuthorRole(owner, [ALL])).toEqual(allowed);
  });
  test("unknown and malformed atoms are refused even for the owner", () => {
    expect(engine.canAuthorRole(owner, ["posts.delete"])).toEqual(denied("unknown atom posts.delete"));
    expect(engine.canAuthorRole(owner, ["podcasts.*"])).toEqual(denied("unknown atom podcasts.*"));
    expect(engine.canAuthorRole(owner, ["posts"])).toEqual(denied("malformed atom posts"));
  });
  test("a role within the actor's atoms is allowed", () =>
    expect(engine.canAuthorRole(editor, ["posts.write.own", "pages.edit"])).toEqual(allowed));
});

describe("canEditRole and canDeleteRole", () => {
  const stationHand = customRole("station_hand", ["radio.manage", "chat.moderate"]);
  test("editing a role needs the old atoms as well as the new", () => {
    // Editor holds chat.moderate but not radio.manage: it cannot strip the radio atom away from a role it couldn't grant.
    expect(engine.canEditRole(editor, stationHand, ["chat.moderate"])).toEqual(denied("missing radio.manage"));
  });
  test("editing a role needs the new atoms as well as the old", () =>
    expect(engine.canEditRole(radioDesk, stationHand, ["radio.manage", "posts.publish"])).toEqual(
      denied("missing posts.publish"),
    ));
  test("an actor holding old ∪ new can edit", () =>
    expect(engine.canEditRole(admin, stationHand, ["radio.*", "posts.publish"])).toEqual(allowed));
  test("an edit cannot add a reserved atom", () =>
    expect(engine.canEditRole(owner, stationHand, ["owner.transfer"])).toEqual(
      denied("owner.transfer is reserved for the owner"),
    ));
  test("built-in roles are read-only, even for the owner", () => {
    for (const builtin of fixtureRoles) {
      expect(engine.canEditRole(owner, builtin, builtin.atoms)).toEqual(denied("built-in roles are read-only"));
      expect(engine.canDeleteRole(owner, builtin)).toEqual(denied("built-in roles are read-only"));
    }
  });
  test("a built-in role passed with builtin: false is still read-only", () => {
    const disguised = { ...fixtureRoles[2]!, builtin: false };
    expect(engine.canEditRole(owner, disguised, ["posts.publish"])).toEqual(denied("built-in roles are read-only"));
    expect(engine.canDeleteRole(owner, disguised)).toEqual(denied("built-in roles are read-only"));
  });
  test("deleting a custom role needs its atoms", () => {
    expect(engine.canDeleteRole(editor, stationHand)).toEqual(denied("missing radio.manage"));
    expect(engine.canDeleteRole(radioDesk, stationHand)).toEqual(allowed);
  });
  test("an admin can edit a custom role the owner made with *", () =>
    expect(engine.canEditRole(admin, customRole("everything", [ALL]), ["posts.*"])).toEqual(allowed));
});

describe("canManagePerson", () => {
  const person = (roleId: string, flags: { isOwner?: boolean; isSelf?: boolean } = {}) => ({
    atoms: atomsOf(roleId),
    isOwner: flags.isOwner ?? false,
    isSelf: flags.isSelf ?? false,
  });
  test("the owner cannot be changed, even by the owner", () => {
    expect(engine.canManagePerson(admin, person("owner", { isOwner: true }))).toEqual(denied("the owner cannot be changed"));
    expect(engine.canManagePerson(owner, person("owner", { isOwner: true, isSelf: true }))).toEqual(
      denied("the owner cannot be changed"),
    );
  });
  test("nobody changes themselves", () => {
    expect(engine.canManagePerson(admin, person("admin", { isSelf: true }))).toEqual(denied("cannot change your own role"));
    expect(engine.canManagePerson(editor, person("editor", { isSelf: true }))).toEqual(denied("cannot change your own role"));
  });
  test("admins are peers of each other", () => expect(engine.canManagePerson(admin, person("admin"))).toEqual(allowed));
  test("an editor cannot manage an admin", () => expect(engine.canManagePerson(editor, person("admin")).allowed).toBe(false));
  test("an editor cannot manage a dj (lacks radio.password.own)", () =>
    expect(engine.canManagePerson(editor, person("dj"))).toEqual(denied("missing radio.password.own")));
  test("the owner can manage an admin", () => expect(engine.canManagePerson(owner, person("admin"))).toEqual(allowed));
  test("a dj cannot manage a contributor (lacks media.manage)", () =>
    expect(engine.canManagePerson(dj, person("contributor"))).toEqual(denied("missing media.manage")));
});
