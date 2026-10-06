import { finished } from "node:stream/promises";
import { PassThrough, type Duplex } from "node:stream";
import Dockerode from "dockerode";
import { and, eq } from "drizzle-orm";
import type { Store } from "../db/client.js";
import { getDb } from "../db/client.js";
import { agents, user } from "../db/schema.js";

const image = "nano-agents-linux:1";
const memoryBytes = 10 * 1024 * 1024 * 1024;
const storageSize = "50G";
const toolchainRepairs = new Map<string, Promise<void>>();
const containerNameByAccount = new Map<string, string>();

const docker = new Dockerode({
  socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
});

export type ExecResult = { stdout: string; code: number };

/**
 * Returns the directory every agent on this account's Linux can use.
 * Input: the account id. The container already belongs to that account.
 * Output: /shared inside that account's Linux.
 */
export function accountShared(_accountId: string): string {
  return "/shared";
}

/**
 * Returns one agent's home on that account's Linux.
 * Input: the account id and the Linux username.
 * Output: the absolute home path. Another account's container does not have this home.
 */
export function accountHome(_accountId: string, profile: string): string {
  return `/home/${profile}`;
}

/**
 * Starts one Linux container for one account.
 * Why: exactly one container per account (name derived from the sign-in email;
 * tests without a user row keep nano-<accountId>). Test runs label their
 * containers nano.test=1 so cleanup can wipe test computers
 * without ever touching the developer's real account container on the same
 * Docker daemon. Concurrent first-use calls race safely: the loser of the
 * createContainer name race falls back to the winner's container instead of
 * 409ing the request.
 * Input: the account id.
 * Output: the container id. A second call returns the container that is already running.
 */
export async function createLinux(accountId: string, email?: string): Promise<string> {
  await ensureImage();
  const name = await resolveContainerName(accountId, email);
  const labels: Record<string, string> = { "nano.account": accountId };
  if (email) {
    labels["nano.email"] = email.trim().toLowerCase();
  }
  if (process.env.NODE_ENV === "test") {
    labels["nano.test"] = "1";
  }
  const existing = docker.getContainer(name);
  try {
    const info = await existing.inspect();
    if (!info.State.Running) {
      await existing.start();
    }
    await ensureMemory(existing, info.HostConfig?.Memory ?? 0);
    await ensureBaseToolchain(accountId);
    return info.Id;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== 404) {
      throw error;
    }
  }
  try {
    const container = await docker.createContainer({
      name,
      Image: image,
      Labels: labels,
      HostConfig: accountContainerHostConfig(accountId),
    });
    await container.start();
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== 409) {
      throw error;
    }
    // Lost the name race with a concurrent first-use: adopt the winner.
    const winner = await docker.getContainer(name).inspect();
    if (!winner.State.Running) {
      await docker.getContainer(name).start();
    }
    return winner.Id;
  }
  await ensureBaseToolchain(accountId);
  const made = await exec(accountId, ["sh", "-c", "mkdir -p /shared && chmod 1777 /shared"]);
  if (made.code !== 0) {
    throw new Error(made.stdout || "The shared directory was not created.");
  }
  return docker.getContainer(name).inspect().then((info) => info.Id);
}

/**
 * Runs a command in an account container.
 * Input: the account id, the command argv, and an optional Linux user.
 * Output: the combined stdout and the exit code.
 */
export async function exec(accountId: string, command: string[], user = "root", env?: string[]): Promise<ExecResult> {
  const result = await execBytes(accountId, command, user, env);
  return { stdout: result.stdout.toString("utf8"), code: result.code };
}

/**
 * Runs a command and keeps stdout as bytes.
 * Input: the account id, the command argv, an optional Linux user, and optional environment entries.
 * Output: the stdout bytes and the exit code.
 */
export async function execBytes(
  accountId: string,
  command: string[],
  user = "root",
  env?: string[],
): Promise<{ stdout: Buffer; code: number }> {
  const container = docker.getContainer(await resolveContainerName(accountId));
  const running = await container.exec({
    Cmd: command,
    User: user,
    Env: env,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await running.start({ hijack: true, stdin: false });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
  container.modem.demuxStream(stream, stdout, stderr);
  await finished(stream);
  const info = await running.inspect();
  return { stdout: Buffer.concat(chunks), code: info.ExitCode ?? 1 };
}

/**
 * Runs a command with bytes piped to its stdin, keeping stdout as bytes.
 * Why: multi-megabyte blobs (phone attachments) exceed ARG_MAX when passed as
 * argv, so base64-in-argv tricks fail past ~2MB. Streaming via stdin has no
 * such ceiling: one exec per file regardless of size.
 * Input: account id, command argv, stdin bytes, optional user/env.
 * Output: the stdout bytes and the exit code.
 */
export async function execStdin(
  accountId: string,
  command: string[],
  stdin: Buffer,
  user = "root",
  env?: string[],
): Promise<{ stdout: Buffer; code: number }> {
  const container = docker.getContainer(await resolveContainerName(accountId));
  const running = await container.exec({
    Cmd: command,
    User: user,
    Env: env,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await running.start({ hijack: true, stdin: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
  container.modem.demuxStream(stream, stdout, stderr);
  stream.write(stdin);
  stream.end();
  await finished(stream);
  const info = await running.inspect();
  return { stdout: Buffer.concat(chunks), code: info.ExitCode ?? 1 };
}

/**
 * Connects a socket to a command's stdin and stdout inside the account container.
 * Input: the account id, the command argv, and the caller's socket.
 * Output: nothing. Bytes flow both ways until either side closes.
 */
export async function pipeExec(accountId: string, command: string[], socket: Duplex, preamble?: Buffer): Promise<void> {
  const container = docker.getContainer(await resolveContainerName(accountId));
  const running = await container.exec({
    Cmd: command,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await running.start({ hijack: true, stdin: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stderr.resume();
  container.modem.demuxStream(stream, stdout, stderr);
  if (preamble) {
    stream.write(preamble);
  }
  stdout.pipe(socket, { end: true });
  socket.on("data", (chunk: Buffer) => {
    stream.write(chunk);
  });
  socket.on("close", () => stream.end());
  stream.on("error", () => socket.destroy());
  stream.on("end", () => socket.end());
}

/**
 * Creates the agent's user on the account Linux.
 * Why: the account container may be gone (Docker prune, test teardown wiping
 * all nano.* containers, or restart on a fresh host) while the account row
 * survives in Postgres. Ensuring the container first makes profile creation
 * self-healing: the next chat/conversation request recreates it instead of
 * 500ing with "No such container". createLinux is idempotent (returns or
 * starts the existing container), so the happy path costs one inspect.
 * Input: the database, the account id, and the agent id.
 * Output: the username. The home is mode 700 and is stored on the agent.
 */
export async function createProfile(store: Store, accountId: string, agentId: string): Promise<string> {
  const [agent] = await store
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  if (!agent) {
    throw new Error("Agent not found.");
  }
  await createLinux(accountId);
  const username = agent.linuxProfile ?? `u${agentId.replaceAll("-", "").slice(0, 16)}`;
  await ensureProfile(accountId, username);
  if (!agent.linuxProfile) {
    await store
      .update(agents)
      .set({ linuxProfile: username })
      .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  }
  return username;
}

/**
 * Makes one agent profile ready for autonomous work inside its account container.
 * Why: shell-only jobs may run before a desktop is opened, so user creation and
 * container-local admin rights cannot depend on desktop boot. Re-running this
 * repairs profiles after a container recreation and is safe for existing users.
 * Input: account id and generated Linux username. Output: nothing; throws when
 * the profile or sudo policy cannot be established.
 */
async function ensureProfile(accountId: string, username: string): Promise<void> {
  const home = accountHome(accountId, username);
  const exists = await exec(accountId, ["id", "-u", username]);
  if (exists.code !== 0) {
    const added = await exec(accountId, ["useradd", "-m", "-d", home, "-s", "/bin/bash", username]);
    if (added.code !== 0) {
      throw new Error(added.stdout || "The Linux user was not created.");
    }
  }
  const locked = await exec(accountId, ["chmod", "700", home]);
  if (locked.code !== 0) {
    throw new Error(locked.stdout || "The home directory was not locked.");
  }
  const sudoers = await exec(accountId, [
    "sh",
    "-c",
    `printf '%s ALL=(ALL) NOPASSWD:ALL\\n' '${username}' > '/etc/sudoers.d/nano-${username}' && chmod 440 '/etc/sudoers.d/nano-${username}'`,
  ]);
  if (sudoers.code !== 0) {
    throw new Error(sudoers.stdout || "The Linux admin policy was not created.");
  }
}

/**
 * Removes account containers created by this process.
 * Why: test runs must never delete the developer's real account computer
 * sharing the same Docker daemon. Pass {testOnly:true} to remove solely
 * containers labeled nano.test=1 (set by createLinux under NODE_ENV=test).
 * Input: optional {testOnly} scope flag. Output: nothing.
 */
export async function removeAccountContainers(options?: { testOnly?: boolean }): Promise<void> {
  const labelFilter = options?.testOnly ? ["nano.account", "nano.test=1"] : ["nano.account"];
  const containers = await docker.listContainers({ all: true, filters: { label: labelFilter } });
  await Promise.all(
    containers.map(async (container) => {
      const accountId = container.Labels["nano.account"];
      await docker.getContainer(container.Id).remove({ force: true });
      if (accountId) {
        try {
          await docker.getVolume(`nano-account-${accountId}`).remove();
        } catch {
          // The volume was already removed with the container.
        }
      }
    }),
  );
}

/**
 * Docker-safe container name for one account email.
 * Input: the person's sign-in email. Output: nano-<sanitized-email>.
 */
export function containerName(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const local = trimmed
    .replace(/@/g, "-at-")
    .replace(/\+/g, "-plus-")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = local || "account";
  return `nano-${safe}`;
}

async function resolveContainerName(accountId: string, emailHint?: string): Promise<string> {
  const cached = containerNameByAccount.get(accountId);
  if (cached) {
    return cached;
  }
  if (emailHint?.trim()) {
    const name = containerName(emailHint);
    containerNameByAccount.set(accountId, name);
    return name;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const store = getDb(databaseUrl);
    const [row] = await store
      .select({ email: user.email })
      .from(user)
      .where(eq(user.accountId, accountId))
      .limit(1);
    if (row?.email) {
      const name = containerName(row.email);
      containerNameByAccount.set(accountId, name);
      return name;
    }
  }
  const fallback = `nano-${accountId}`;
  containerNameByAccount.set(accountId, fallback);
  return fallback;
}

/**
 * Host settings for one account cage.
 * Why: the container must not see the Docker socket or another account's volume.
 * Input: account id. Output: Docker HostConfig. Privileged stays off.
 */
export function accountContainerHostConfig(accountId: string): Dockerode.HostConfig {
  const binds = [`nano-account-${accountId}:/var/nano`];
  if (binds.some((bind) => bind.includes("docker.sock") || bind.startsWith("/") && !bind.startsWith("nano-account-"))) {
    throw new Error("Account containers cannot mount the host.");
  }
  return {
    Memory: memoryBytes,
    MemorySwap: memoryBytes,
    NanoCpus: 2_000_000_000,
    StorageOpt: { size: storageSize },
    Binds: binds,
    Privileged: false,
  };
}

async function ensureMemory(container: Dockerode.Container, current: number): Promise<void> {
  if (current >= memoryBytes) {
    return;
  }
  await container.update({ Memory: memoryBytes, MemorySwap: memoryBytes });
}

/**
 * Repairs older account containers to the current autonomous-work baseline.
 * Why: account computers are durable and are not recreated when the image
 * changes; this idempotent check gives existing employees Node, Python, and
 * build tools without deleting their homes, browser sessions, or files.
 */
async function ensureBaseToolchain(accountId: string): Promise<void> {
  const active = toolchainRepairs.get(accountId);
  if (active) return active;
  const repair = repairBaseToolchain(accountId).finally(() => {
    if (toolchainRepairs.get(accountId) === repair) toolchainRepairs.delete(accountId);
  });
  toolchainRepairs.set(accountId, repair);
  return repair;
}

/**
 * Performs the actual toolchain probe/install behind the per-account
 * single-flight guard, preventing concurrent first-use apt/dpkg lock races.
 */
async function repairBaseToolchain(accountId: string): Promise<void> {
  const ready = await exec(accountId, [
    "sh",
    "-c",
    "command -v node >/dev/null && command -v npm >/dev/null && command -v python3 >/dev/null && python3 -m pip --version >/dev/null 2>&1",
  ]);
  if (ready.code === 0) return;
  const installed = await exec(accountId, [
    "sh",
    "-c",
    "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git build-essential nodejs npm python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*",
  ]);
  if (installed.code !== 0) {
    throw new Error(installed.stdout || "The Linux Node/Python toolchain was not installed.");
  }
}

async function ensureImage(): Promise<void> {
  try {
    await docker.getImage(image).inspect();
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 404) {
      throw new Error(`Linux image ${image} is missing. Build apps/core/linux/Dockerfile first.`);
    }
    throw error;
  }
}
