# Access: permission atoms, roles and the grant ceiling

`@yl/editor/access` is a small role-based access control engine with no framework in it. It answers questions like
"may this person publish pages?" or "may this person give that role to someone?" and returns a verdict with a reason.
It does not store anything or enforce anything. Your application does both.

Its only runtime dependency is zod, which it uses to validate a catalogue.

## Atoms

A **permission atom** names one gated action, spelt `family.verb`:

```
posts.publish
pages.edit
radio.manage
```

Families and verbs are `lower_snake_case`, and a verb may have further segments. The usual extra segment is `.own`
(`posts.write.own`), meaning the action applies to a resource the actor owns. "Own" is a check on the resource, not a
scope. The engine treats `posts.write.own` as just another atom, and your call site does the ownership check:

```ts
const mayEdit =
  engine.can(atoms, "posts.write.any") || (engine.can(atoms, "posts.write.own") && post.authorId === user.id);
```

Atoms are opaque apart from wildcards. Holding `posts.write.any` does not imply `posts.write.own`. If you want both,
list both.

The vocabulary is defined in code, in your **catalogue**. A gate names its atom, and nobody can invent new atoms from
an admin screen.

## Wildcards

Two wildcards are atoms too, and a role can hold them:

- `family.*` confers every atom in that family, including ones added later. A role holding `radio.*` picks up a future
  `radio.schedule` without a migration.
- `*` confers everything.

Resolution (`holds(held, atom)`) checks the exact atom first, then the family wildcard, then `*`. When the atom you
ask about is itself a wildcard, the question is whether that wildcard is held. `family.*` is held only through
`family.*` or `*`, and `*` only through `*`. Holding every atom in the radio family one by one does not count as
holding `radio.*`, because `radio.*` also promises atoms that do not exist yet.

`parseAtom` throws an `AtomError` on malformed input (`posts`, `posts..x`, `posts.write.*`, `*.publish`).
`holds` never treats a malformed atom as held.

## Roles

A **role** is a named bundle of atoms with a label and a one-line description, which a role picker can show.

- **Built-in roles** are listed in the catalogue. They are reference data, and nothing in the engine lets anyone
  change them: `canEditRole` and `canDeleteRole` always deny them, even for the owner. The engine identifies a built-in
  role by its id, so passing one in with `builtin: false` does not make it editable.
- **Custom roles** are created and stored by your application. You pass them to the engine as `RoleDefinition`s. A
  custom role cannot reuse a built-in role's id.

`engine.atomsOfRole(role)` takes a built-in role's id or a custom role's definition and returns the atoms that role
actually confers. It drops unknown atoms, such as one a stored custom role still names after the catalogue removed it.
It also subtracts the owner-reserved set, described next.

## The owner and the reserved set

The catalogue names one **owner role**, which must be built in and must hold `*`. It also lists an **owner-reserved
set** of atoms, for example `owner.transfer`, which only the owner role can confer.

- The catalogue is rejected if any non-owner role names a reserved atom.
- Every other role has the reserved set subtracted. A role holding `*` that is not the owner gets every family
  wildcard instead, and families that contain reserved atoms are listed atom by atom, without the reserved ones. In
  the usual pattern, an "Admin" role holding `*` ends up with everything except `owner.transfer`, and does not hold
  `*` itself.
- No role can be authored with a reserved atom, not even by the owner.

Because an admin does not hold `*`, the grant ceiling below stops an admin creating an owner. One reserved atom is
enough to keep the owner apart.

## The grant ceiling

Nobody can hand out a permission they do not hold. With `actor` as the actor's resolved atom set:

| Question                         | Allowed when                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `canAssignRole(actor, role)`     | every atom of the role is covered by `actor`                                                   |
| `canAuthorRole(actor, atoms)`    | every atom is well formed, known (or a wildcard over a known family), not reserved and covered |
| `canEditRole(actor, role, next)` | the role is custom, and `actor` covers the old atoms **and** can author the new ones           |
| `canDeleteRole(actor, role)`     | the role is custom, and `actor` covers its atoms                                               |
| `canManagePerson(actor, target)` | the target is not the owner, is not the actor, and the target's atoms are covered              |

"Covered" is `covers(actor, atoms)`: every atom resolves from `actor` as described under wildcards. Creating a custom
role that holds `radio.*` therefore needs `radio.*` or `*`. Editing a role needs the old atoms as well as the new ones
because an edit changes everyone who holds the role, so it is bounded like granting the role again.

Some consequences:

- An admin can assign, change or remove another admin. Admins are peers of each other.
- An admin cannot assign the owner role (`missing *`).
- Nobody changes their own role, and nobody changes the owner. Ownership moves only through your own transfer flow,
  gated on the reserved atom.

The engine does not know which atom gates role management in your catalogue (for example `roles.manage` or
`people.manage`). Check that gate yourself before asking the ceiling questions.

## Verdicts

Every decision returns an `AccessVerdict`:

```ts
type AccessVerdict = { allowed: true } | { allowed: false; reason: string };
```

Reasons are short, stable strings that a UI can show as they are and code can match on:

| Reason                                     | Meaning                                      |
| ------------------------------------------ | -------------------------------------------- |
| `missing pages.publish`                    | the first atom the actor lacks               |
| `unknown atom posts.delete`                | not in the catalogue                         |
| `malformed atom posts`                     | outside the grammar                          |
| `owner.transfer is reserved for the owner` | a reserved atom in an authored role          |
| `built-in roles are read-only`             | edit or delete of a built-in role            |
| `cannot change your own role`              | the target is the actor                      |
| `the owner cannot be changed`              | the target is the owner                      |
| `not signed in`                            | `documentAccess` had no atoms                |
| `no permission mapped for type product`    | `documentAccess` has no mapping for the type |

## Documents: `documentAccess`

`documentAccess` adapts atoms to the package's `Access` seam, which the editor calls before every draft write and
publish. You map each document type to an edit atom and a publish atom:

```ts
import { createAccessEngine, documentAccess } from "@yl/editor/access";
import { catalogue } from "./permissions"; // your catalogue

const engine = createAccessEngine(catalogue); // throws CatalogueError if the catalogue is inconsistent

export const access = documentAccess({
  // Resolve once per session and keep the set on locals, so this is a lookup rather than a query.
  atomsOf: (locals) => (locals as { user?: { atoms: ReadonlySet<string> } }).user?.atoms ?? null,
  map: {
    page: { edit: "pages.edit", publish: "pages.publish" },
    event: { edit: "pages.edit", publish: "pages.publish" },
    show: { edit: "radio.manage", publish: "radio.manage" },
  },
});

// At sign-in: user.atoms = engine.atomsOfRole(user.roleId)
```

It fails closed. If `atomsOf` returns `null`, the verdict is `not signed in`. A document type with no entry in the map
is denied for everyone, the owner included, so a new type stays locked until someone maps it. Otherwise it allows the
action if the mapped atom is held, including through `family.*` or `*`, and if not, the reason names the missing atom.
A malformed atom in the map throws when `documentAccess` is called, so the mistake shows up at start-up.

## Catalogue validation

`createAccessEngine` validates the catalogue, and so does `validateCatalogue(input)` on its own. Both throw a
`CatalogueError` whose `problems` list every issue found. The catalogue's shape is `CatalogueSchema`, a zod schema.
Beyond that shape, the checks are:

- every atom is well formed, concrete (not a wildcard), unique, and its `family` matches its spelling
- role ids are unique
- every role atom is a known atom, a wildcard over a known family, or `*`
- every reserved atom is a known atom, and no non-owner role names one
- the owner role exists, is built in and holds `*`

## Who does what

The engine is the **policy decision point**. It answers questions and nothing more. Your application:

- **stores** roles and people: the custom roles table, each person's role, the single owner
- **resolves** a person's atoms (`atomsOfRole`) when loading the session, so checks are set lookups
- **enforces** at the write. The endpoint, database trigger or row-level security policy that performs the change
  must ask the engine, or apply the same rule, at the moment of writing. Hiding a button is not enforcement.
- **enforces invariants the engine cannot see**, such as "exactly one owner", in the database
- **logs** every role and permission change

**One role per person** is the recommended shape. Someone who needs two bundles gets a custom role that holds both,
and the ceiling checks still work on one set of atoms. If your application instead gives a person the union of several
roles, be careful. Merging permissions from several grants is where other access systems have had privilege
escalation bugs, for example a grant that should have been limited to one scope ending up applied everywhere, or a
revoked grant still being supplied by another. If you do union roles, compute the union in one place, test it against
the ceiling questions as an escalation case, and never union the owner-reserved set into a non-owner.
