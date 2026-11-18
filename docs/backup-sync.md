# Backup and sync between devices

Issue [#112](https://github.com/phenix3443/agent-store/issues/112). Agent Store backs up what is installed on this machine to
a Git repository the user owns, and brings the changes made on other devices back in. There is no server-side sync;
this is the only way settings move between machines.

Code: `apps/client-core/src/backup/` (the CLI and the desktop client both call it through `Engine`), commands in
`apps/cli/src/commands/backup.ts`, types in `packages/types/src/backup.ts`.

## Connecting

There are two ways to connect: sign in with GitHub, which creates the repository, or give the URL of any Git
repository.

### Connecting with GitHub

```
aas backup connect --github [--device <name>] [--new]
```

In the desktop client this is the **GitHub** option of the connect dialog, the default.

1. **Code:** Agent Store starts GitHub's [device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
   and shows a code and the address to enter it at, `https://github.com/login/device`. The client opens that page.
2. **Approval:** the user enters the code and authorizes Agent Store on GitHub. Agent Store polls at the interval GitHub
   gives, slower when GitHub asks it to.
3. **Repository:** Agent Store reads the signed-in account and looks at `agent-store-backup`, then `agent-store-backup-2`,
   `-3`… on it, up to the first free name or ten names:
   - **An earlier backup** (a repository holding `agent-store-backup.json`) is offered. The user connects to it, or creates
     a new one instead (`--new` on the CLI; without a terminal to ask, the CLI connects to the backup). A public one is
     flagged as public.
   - **A new backup** goes to the first name that is free, created as a private repository with no initial commit. An
     empty private repository under one of these names, left by an attempt that did not finish, is used instead of
     creating another.
   - A name holding anything else is skipped.
4. **Connection:** the repository is connected as `https://github.com/<owner>/<name>.git` exactly as a Git URL with a
   token would be; everything below applies to it. `status` shows the GitHub account.

**Scope.** The only scope requested is `repo`. An OAuth app has no narrower scope that can create a private repository
and push to it: `public_repo` cannot reach private repositories. A sign-in approved without `repo` is refused.

**How a sign-in ends.** Each end leaves nothing connected and can be retried with a new code:

| End | What happens |
| --- | --- |
| Denied | The user declined on GitHub. Nothing is stored. |
| Expired | The code ran out (GitHub gives about 15 minutes) before it was approved. Nothing is stored. |
| Cancelled | The user cancelled, or closed the dialog. An approved token not connected yet is deleted. |
| Failed | GitHub or the network failed, or the repository could not be created. The error says which; see the `reason` table below. |

**The token.**

- **Before connecting:** from approval until the repository is connected, it is kept in
  `~/.agent-store/backup/github-signin.json` (mode 0600). It is deleted once connected, on cancel and by the next sign-in;
  older than 30 minutes, it is refused and deleted. When the connection fails, it stays there for another try without approving
  again; the desktop client deletes it and starts a new sign-in instead.
- **Once connected:** it moves to `credentials.json`, the same file and handling as any HTTPS token. It is checked for in
  every export like the other backup tokens.
- **Never:** in an RPC result or the desktop client's window, in argv, in a log line, in an error message or in the
  repository.
- **Revoking:** `disconnect --revoke` and `--delete-remote` revoke it on GitHub; plain `disconnect` only deletes it from
  this machine. See [Disconnecting](#disconnecting).

**The OAuth app.** The device flow needs the client id of an OAuth app with *Enable Device Flow* checked. It needs no
callback URL and no client secret, so no secret is in the code or the build. The id is the `DEFAULT_GITHUB_CLIENT_ID`
constant in `apps/cli/src/engine.ts`. `AS_GITHUB_CLIENT_ID` overrides it, and `AS_GITHUB_URL` and `AS_GITHUB_API_URL`
point at another GitHub. While it is empty, the GitHub path stops at once with `github-not-configured` and the Git-URL
path is unaffected.

### Connecting with a Git URL

```
aas backup connect <git-url> [--branch <b>] [--device <name>] [--username <u>] [--token-stdin]
```

- **Remote:** any Git remote works: HTTPS, SSH, a self-hosted server, a local path. Agent Store runs the system `git`,
  so SSH keys, credential helpers and proxies the user has set up apply as they are.
- **HTTPS token:** `--token-stdin` reads it from stdin, never from the command line.
  - It is stored in `~/.agent-store/backup/credentials.json` (mode 0600).
  - It reaches git only through an environment variable read by a credential helper given on the command line, so it is
    in neither argv nor `.git/config`.
  - A `user:token@` in a pasted HTTPS URL is moved there too.
  - A token with an SSH remote is refused.
- **Branch:** the remote's default branch, else `main`.
- **Repository contents:** the branch must be empty or already hold an Agent Store backup (`agent-store-backup.json`).
  Anything else is refused and nothing is left behind.
- **Device:** the name defaults to the host name. It is the author of every commit this device makes.
- **No sync yet:** connecting copies nothing in either direction.
  - On a new machine, `aas backup pull` installs what the backup holds.
  - `aas backup now` merges both ways.

## What is in the backup

```
agent-store-backup.json                 {"format":"agent-store-backup","schema":1}
items/<skill|mcp|provider>/<slug>/
  state.json                            enabled flag per agent
  content/item.json                     version, catalog id, compatible agents, duplicate's parent,
                                        manifest and config without secrets (MCP servers, providers)
  content/files/                        skills: the whole library directory
```

Every installed item is in it: skills, MCP servers and providers, duplicated providers included. JSON is written with
sorted keys, so the same state gives the same files on every device.

Never in it:

- **Provider credentials:** `apiKey`, `apiKeys`, `token`.
- **Secret config values:** any config value marked `x-secret`, `x-bearer`, `writeOnly` or `format: password` in the
  item's schema, or named like a key, token, secret, password, credential, authorization, cookie or session.
- **Agent Store's own secret files:** the relay token, `project-env.json`, the backup credentials.
- **Other tools' files:** Agent Store does not read the agents' own files for the backup, `auth.json` and settings
  included.
- **Machine-local state:**
  - deployment records;
  - MCP `targets.json` (it holds the written entries, secret values included);
  - files an MCP install hook downloaded (they are fetched again from the manifest);
  - usage data, relay ports and state, the catalog cache, the plan, the budget.
- **Registered projects:** their paths belong to one machine, their items are committed in the project's own repository,
  and their stored values are secrets.
- **Excluded skill files:** inside a skill directory, `.git`, `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa` and
  similar, `auth.json`, `credentials.json`, `project-env.json`, and files only their owner can read.
  - The owner-only rule applies only when `SKILL.md` itself is readable by others, and not on Windows.
  - Excluded files are listed in the results and in `status`.

Skills over 100 MB stay on the machine that has them:

- **Placeholder:** the backup holds a placeholder for the skill, and `status` lists it as kept local.
- **Content:** a placeholder never replaces real content, and remote content is never written over a local skill that is
  over the limit.
- **Other devices:** a device without the skill reports it as not available and does not delete it from the backup.

### Secret check

Before anything is written to the repository, every exported file is checked for two things:

1. **Known values:** every value taken out above, the relay token, the stored project values and the backup token, when
   at least 8 characters long.
2. **Key formats:** Anthropic and OpenAI `sk-` keys, GitHub tokens, AWS access key ids, Slack tokens, Google API keys,
   PEM private keys. Placeholders such as `sk-xxxx…` do not count.

A hit stops the whole operation before any Git object is created. The error names the item and file and what was found,
never the value. `status` shows the same finding.

## Syncing

| Command | What it does |
| --- | --- |
| `aas backup now` | Snapshot, export, fetch, merge, commit on top of the remote, push, then apply what came from the remote |
| `aas backup pull` | Fetch, merge, apply remote changes; local changes stay for the next `now` |
| `aas backup status [--fetch]` | Connection, last sync, local changes, conflicts, missing keys, failures, local-only items; `--fetch` counts remote commits not applied yet |
| `aas backup log [--limit N]` | Backup commits with the device that made each |

From the CLI, sync runs only when one of these commands runs. The desktop client can also sync on its own while it is open; see [For the desktop client](#for-the-desktop-client).

### How items are merged

The merge is per item, not per line. It compares three versions of each item: the last synced commit, this machine's
export and the fetched remote.

**Parts.** Each item has two parts, compared by their Git object ids:

- the content (`content/`);
- the enabled flags (`state.json`).

For each part:

| This machine | Remote | Result |
| --- | --- | --- |
| changed | unchanged | this machine's version |
| unchanged | changed | the remote's version |
| changed | changed, to the same | that version |
| changed | changed, differently | the item is in conflict |

So a skill edited on one device and switched off for Codex on another ends up edited and off.

**Deletions.**

- Removed on one side and unchanged on the other: removed.
- Removed on one side and changed on the other: conflict.

**First sync** (no common commit yet, or the remote history was rewritten):

- An item on one side only is taken.
- An item on both sides that differs is a conflict.

Nothing is treated as deleted.

**Commits and push.**

- History stays linear: the new commit's parent is the remote head.
- A rejected push fetches and merges again, up to three times.
- A branch that disappeared from the remote after a sync is refused, so an emptied remote cannot uninstall everything.

### Applying remote changes

Remote changes go through the same engine calls as a manual install, enable or uninstall, so the ownership rules for
tool files hold. The backup is the source, not the store.

- **Skills** are written from the backup files into the library and deployed to the agents they are enabled for.
- **MCP servers and providers** are installed or updated from the backup's manifest.
  - Their config becomes the backup's values plus this machine's own secret values.
  - A key set on this machine survives remote changes.

After applying, the item is exported again. If it still differs from the backup, it is listed as failed and the remote
version is applied again on the next sync. A half-applied item is never uploaded as a local change or a removal.

### Missing keys

An item that is enabled in the backup but cannot be enabled here is installed and left disabled:

- a provider without a key (`no-key`);
- an MCP server missing a required value (`needs-config`).

It is listed under missing keys with the command to set it. Until it is enabled here, this machine keeps reporting it as
enabled in the backup, so it never uploads a disable nobody chose. An enable that fails for another reason, such as the
relay not starting, is handled the same way and listed as failed.

## Conflicts

- **While pending:**
  - this machine keeps its own version;
  - the remote keeps the remote version;
  - every other item keeps syncing.
- **Listed by:** `aas backup conflicts` and `status` list each conflicting item with what differs and the device that last
  changed it.

```
aas backup resolve <item> local|remote|both        <item>: slug or <kind>/<slug>
```

- `local`: this machine's version is uploaded by the next `now`.
- `remote`: the remote version is installed here.
- `both`: this machine's version stays, and the remote one is installed as `<slug>-<device>` (numbered if taken) and
  enabled nowhere. Both are uploaded by the next `now`.

Every choice first takes a snapshot; `resolve` prints the command that restores it. A conflict also clears itself when
both sides become equal.

## Snapshots

A snapshot is a commit of this machine's export under `refs/agent-store/snapshots/<id>` in the local repository. It holds
no secrets and is never pushed. The last 30 are kept.

- **When one is taken:** before `now`, `pull`, `resolve` and `restore`. When nothing changed since the newest snapshot,
  that one is reused.
- `aas backup snapshots` lists them.
- **`aas backup restore <id>`:**
  1. snapshots the current state;
  2. makes this machine match the snapshot: installs, updates, removes and switches items, keeping this machine's secret
     values.

  The next `now` uploads the result.

## Disconnecting

```
aas backup disconnect [--revoke | --delete-remote [--confirm <owner>/<name>]] [--yes]
```

Three levels. Each does the ones before it, and each is explained before it runs: the CLI prints what it will do, the
desktop client's 断开… dialog lists what is done and what is left for the level picked.

| Level | Done | Left as it is |
| --- | --- | --- |
| This device only (default) | `~/.agent-store/backup/` is deleted: the local repository, its snapshots and the stored token | The remote and the backup in it; other devices keep syncing, and connecting again finds the backup. A GitHub token is not revoked |
| `--revoke` | This device's GitHub token is revoked, then the above | The repository; other devices keep syncing with their own sign-in, since every device signs in with its own token |
| `--delete-remote` | The GitHub repository is deleted, this device's tokens are revoked, then the above | What is installed on every device. Other devices stay connected, but their sync now fails with `not-found`; disconnect each of them (this device only) |

None of them touches the skills, MCP servers and providers installed on any device.

**GitHub only.** Revoking and deleting are offered only for a connection made by signing in with GitHub, where Agent
Store holds the token and knows the repository (`connection.json` keeps `github.repo`; a connection made before it is
read from the remote URL). For a Git URL they are refused with `not-github`, and the client shows them greyed out with
the reason: Agent Store holds no GitHub authorization for it, and deletes no repository it was not connected to by a
GitHub sign-in. Revoke the token and delete the repository on the Git host instead.

**Revoking.** The token is revoked through GitHub's [credential revocation
endpoint](https://docs.github.com/en/rest/credentials/revoke) (`POST /credentials/revoke`), which takes no
authentication. Revoking the whole authorization (`DELETE /applications/{client_id}/grant`) would need the OAuth app's
client secret, which Agent Store does not have (see [The OAuth app](#connecting-with-github)), so it is not used:

- GitHub emails the account owner that a token was revoked.
- Agent Store may stay listed under Settings › Applications › Authorized OAuth Apps; the result links to its page there,
  `https://github.com/settings/connections/applications/<client id>`, where Revoke removes it.

**Deleting.** `repo` cannot delete a repository, and the connection's token is not given more than it needs, so deleting
takes one more device-code sign-in that asks for `repo delete_repo`:

1. **Name:** the user types the repository's `<owner>/<name>` (any case). The CLI asks before the sign-in, or takes
   `--confirm`; without a terminal and without `--confirm` it stops. The client enables the button once the name matches.
2. **Sign-in:** the same device flow as connecting. The approval must be by the connected account and must grant
   `delete_repo`; otherwise its token is revoked at once and nothing else happens.
3. **Delete:** `DELETE /repos/<owner>/<name>`. A repository that is already gone (404) counts as deleted, so a retry after a
   failure further on finishes.
4. **Revoke:** the connection's token and the deletion token, in one call.
5. **This device:** `~/.agent-store/backup/` is deleted.

**The deletion token.** From approval until it is used it is kept in `~/.agent-store/backup/github-delete.json` (0600),
next to `credentials.json`; older than 30 minutes it is refused, revoked and deleted. Cancelling
(`cancelGitHubBackupSignIn`, or closing the dialog) deletes it and revokes it on GitHub. It is never in an RPC result, the
window, argv, a log line, an error message or the repository, like the connection's token.

**Failures.** The GitHub steps run first and the local folder is deleted last, so a step that fails leaves everything on
this device as it was, the connection included. The error says which step failed:

| `reason` | Step | State |
| --- | --- | --- |
| `confirm-mismatch` | the typed name | nothing was done |
| `github-signin-needed` | the deletion sign-in is missing, too old, for another account or without `delete_repo` | nothing was done |
| `delete-failed` | deleting the repository (e.g. 403 without admin rights) | the repository is still there; nothing was revoked |
| `revoke-failed` | revoking | the message says whether the repository was already deleted; trying again finishes |

**Result.** `disconnectBackup` returns the level, the remote, the repository, whether it was `deleted` or already `gone`,
whether the tokens were revoked, and the authorizations page. The CLI and the client report from it what was done and
what is left on other devices.

## Local files

```
~/.agent-store/backup/repo.git           bare repository (fetched backup, snapshots)
~/.agent-store/backup/connection.json    remote, branch, device
~/.agent-store/backup/credentials.json   HTTPS token (also the GitHub token once connected), 0600
~/.agent-store/backup/github-signin.json GitHub token between approval and connecting, 0600
~/.agent-store/backup/github-delete.json GitHub token (delete_repo) between approval and deleting the repository, 0600
~/.agent-store/backup/state.json         last synced commit, pending conflicts, missing keys, failures
~/.agent-store/backup.lock               one backup operation at a time, across the CLI and the desktop client
```

## For the desktop client

The `Engine` methods are:

- `getBackupStatus`;
- `connectBackup`;
- `startGitHubBackupSignIn`, `pollGitHubBackupSignIn`, `connectGitHubBackup`, `cancelGitHubBackupSignIn`;
- `startGitHubBackupDeleteSignIn`, `pollGitHubBackupDeleteSignIn` (the deletion sign-in);
- `backupNow`, `pullBackup`;
- `resolveBackupConflict`;
- `listBackupSnapshots`, `restoreBackupSnapshot`;
- `listBackupHistory`;
- `disconnectBackup({ level, confirm })`.

The client passes RPC arguments over stdin (`aas __rpc <method> -`), so the token given to `connectBackup` never
reaches argv. Errors carry `code` (class name) and `reason`:

| `reason` | Cause |
| --- | --- |
| `not-connected` | this device is not connected |
| `already-connected` | this device is already connected |
| `foreign-repo` | the remote branch holds something that is not an Agent Store backup |
| `unsupported-schema` | the backup was written in a format this version does not read |
| `token-needs-https` | a token was given for a remote that is not HTTPS |
| `no-conflict` | there is no pending conflict for that item |
| `no-snapshot` | there is no snapshot with that id |
| `ambiguous` | the slug matches more than one conflict; name it as `<kind>/<slug>` |
| `secret-found` | the export holds a secret; nothing was written |
| `export-failed` | an item could not be exported |
| `apply-failed` | a remote change could not be applied |
| `git-missing` | `git` is not on the PATH |
| `rollback-failed` | first-launch restore could not be fully undone; connection and snapshots are retained for recovery |
| `busy` | another backup operation holds `~/.agent-store/backup.lock` |
| `auth-failed` | git: the remote refused the credentials or SSH key (`GitError`) |
| `host-key` | git: the SSH host key is not trusted yet (`GitError`) |
| `not-found` | git: no such repository, or no access to it (`GitError`) |
| `network` | git: the remote could not be reached (`GitError`); or GitHub could not be reached (`BackupGitHubError`) |
| `github-not-configured` | this build has no GitHub OAuth client id, or GitHub refused it (`BackupGitHubError`) |
| `github-signin-needed` | no approved sign-in is waiting, it is too old, GitHub no longer accepts it, or it lacks `repo` (`BackupGitHubError`) |
| `github-failed` | GitHub answered with an error, e.g. creating the repository failed (`BackupGitHubError`) |
| `not-github` | revoking or deleting was asked for a connection not made by signing in with GitHub (`BackupDisconnectError`) |
| `confirm-mismatch` | the repository name typed to delete it does not match (`BackupDisconnectError`) |
| `delete-failed` | deleting the GitHub repository failed; nothing on this device changed (`BackupDisconnectError`) |
| `revoke-failed` | revoking the GitHub token failed; nothing on this device changed (`BackupDisconnectError`) |

The four `GitError` reasons are read from git's and ssh's English messages; any other git failure has no reason.

### First launch on a new computer

Before the welcome/import guide, a client with no welcome record and an empty installed library asks once whether to
start fresh or restore from an existing backup. The choice is saved in the app data directory's
`agent-store-cli/first-launch-backup.json` before continuing. Start fresh continues the welcome guide; Escape does the
same. An existing library, a saved choice or a completed welcome guide suppresses the question. Settings › Backup &
sync remains available later. An install dialog opened by an app or website link defers this choice; the library is
checked again when the install dialog closes. The welcome/import guide also pauses during an install, retaining its step.

Restore opens the existing connection form in Settings › Backup & sync. Connecting alone changes no installed items;
Cancel leaves the library empty. After connecting, “Later” disconnects this first-launch connection. Confirming pull
uses `pullBackup({ firstRun: true })`: it refuses a nonempty library, never pushes, and undoes attempted installs through
the engine if applying or verifying the restore fails. Missing keys are expected: those items remain installed but
disabled until their secrets are entered locally. A rollback failure retains the connection and snapshot for recovery
and reports the error. Tokens follow the same stdin transport and local credentials file rules as other connections;
the first-launch choice file contains only a boolean.

### In the desktop client

Settings › Backup & sync (`apps/cli-gui/src/components/backup/`) covers connecting (new backup or restore from an
existing one, each with GitHub or a Git URL), status, conflicts, missing keys, snapshots, history and disconnecting at the
three levels. Automatic sync runs in the client,
since the CLI has no resident process:

- after a change made through the client (install, enable, config, update, bulk actions…) has been quiet for about 2 minutes, it backs up;
- every 10 minutes it checks the remote: local changes are backed up, a remote ahead is pulled;
- it starts after the first sync the user runs, never before, and can be switched off;
- it waits while one of the client's own changes is still running, and queues every backup call so the client never races
  itself for the lock; when the CLI holds the lock it tries again on the next round;
- failures back off (up to 32 times the interval) and show in the status bar, without pop-ups.

## Not done

- **Automatic sync from the CLI**; only the desktop client syncs on its own.
- **Other hosts' sign-in:** only GitHub (github.com) creates the repository; GitLab, Gitea and others connect by URL.
- **Revoking the whole GitHub authorization:** it needs the OAuth app's client secret; only this device's tokens are
  revoked.
- **Registered projects** in the backup.
