import { finished } from "node:stream/promises";
import { PassThrough } from "node:stream";
import Dockerode from "dockerode";
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents } from "../db/schema.js";

const image = "nano-agents-linux:1";
const memoryBytes = 256 * 1024 * 1024;

const docker = new Dockerode({
  socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
});

export type ExecResult = { stdout: string; code: number };

/**
 * Starts the account's Linux container.
 * Input: the account id.
 * Output: the container id. The container has a private volume and a /shared directory mode 1777.
 */
export async function createLinux(accountId: string): Promise<string> {
  await ensureImage();
  const name = containerName(accountId);
  const previous = docker.getContainer(name);
  try {
    await previous.remove({ force: true });
  } catch {
    // The account has no container yet.
  }
  const container = await docker.createContainer({
    name,
    Image: image,
    Labels: { "nano.account": accountId },
    HostConfig: {
      Memory: memoryBytes,
      NanoCpus: 250_000_000,
      Binds: [`nano-account-${accountId}:/var/nano`],
    },
  });
  await container.start();
  const made = await exec(accountId, ["sh", "-c", "mkdir -p /shared && chmod 1777 /shared"]);
  if (made.code !== 0) {
    throw new Error(made.stdout || "The shared directory was not created.");
  }
  return container.id;
}

/**
 * Runs a command in an account container.
 * Input: the account id, the command argv, and an optional Linux user.
 * Output: the combined stdout and the exit code.
 */
export async function exec(accountId: string, command: string[], user = "root"): Promise<ExecResult> {
  const container = docker.getContainer(containerName(accountId));
  const running = await container.exec({
    Cmd: command,
    User: user,
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
  return { stdout: Buffer.concat(chunks).toString("utf8"), code: info.ExitCode ?? 1 };
}

/**
 * Creates the agent's user on the account Linux.
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
  const username = `u${agentId.replaceAll("-", "").slice(0, 16)}`;
  const home = `/home/${username}`;
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
 * Removes every account container this process created.
 * Input: none.
 * Output: nothing. The containers and their volumes are gone.
 */
export async function removeAccountContainers(): Promise<void> {
  const containers = await docker.listContainers({ all: true, filters: { label: ["nano.account"] } });
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
