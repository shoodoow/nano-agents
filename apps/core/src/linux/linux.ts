import { finished } from "node:stream/promises";
import { PassThrough, type Duplex } from "node:stream";
import Dockerode from "dockerode";
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents } from "../db/schema.js";

const image = "nano-agents-linux:1";
const memoryBytes = 10 * 1024 * 1024 * 1024;
const storageSize = "50G";

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
 * Why: exactly one container per account (name nano-<accountId>). Test runs
 * label their containers nano.test=1 so cleanup can wipe test computers
 * without ever touching the developer's real account container on the same
 * Docker daemon. Concurrent first-use calls race safely: the loser of the
 * createContainer name race falls back to the winner's container instead of
 * 409ing the request.
 * Input: the account id.
 * Output: the container id. A second call returns the container that is already running.
 */
export async function createLinux(accountId: string): Promise<string> {
  await ensureImage();
  const name = containerName(accountId);
  const labels: Record<string, string> = { "nano.account": accountId };
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
      HostConfig: {
        Memory: memoryBytes,
        MemorySwap: memoryBytes,
        NanoCpus: 2_000_000_000,
        StorageOpt: { size: storageSize },
        Binds: [`nano-account-${accountId}:/var/nano`],
      },
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
  const container = docker.getContainer(containerName(accountId));
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
  const container = docker.getContainer(containerName(accountId));
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
  const container = docker.getContainer(containerName(accountId));
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
export async function createProfile(db: ReturnType<typeof getDb>, accountId: string, agentId: string): Promise<string> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  if (!agent) {
    throw new Error("Agent not found.");
  }
  if (agent.linuxProfile) {
    return agent.linuxProfile;
  }
  await createLinux(accountId);
  const username = `u${agentId.replaceAll("-", "").slice(0, 16)}`;
  const home = accountHome(accountId, username);
  const added = await exec(accountId, ["useradd", "-m", "-d", home, "-s", "/bin/bash", username]);
  if (added.code !== 0 && !added.stdout.includes("already exists")) {
    throw new Error(added.stdout || "The Linux user was not created.");
  }
  const locked = await exec(accountId, ["chmod", "700", home]);
  if (locked.code !== 0) {
    throw new Error(locked.stdout || "The home directory was not locked.");
  }
  await db
    .update(agents)
    .set({ linuxProfile: username })
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  return username;
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

function containerName(accountId: string): string {
  return `nano-${accountId}`;
}

async function ensureMemory(container: Dockerode.Container, current: number): Promise<void> {
  if (current >= memoryBytes) {
    return;
  }
  await container.update({ Memory: memoryBytes, MemorySwap: memoryBytes });
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
