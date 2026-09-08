import { SlackClient, isRevokedSlackToken } from "./slack";
import { decryptSlackToken } from "./slack-token-crypto";
import type { CycleStore, SlackWorkspace } from "./storage";

export class SlackResolver {
  constructor(
    private readonly store: Pick<CycleStore, "getSlackWorkspaceByTeamId" | "getSlackWorkspaceByTenantId">,
    private readonly encryptionKey: Buffer | null,
    private readonly createClient: (token: string) => SlackClient = (token) => new SlackClient(token),
  ) {}

  // Keep this lookup separate from decryption so member-join events can reject
  // ordinary users using the verified, persisted bot identity first.
  async workspaceForTeam(teamId: string): Promise<SlackWorkspace | null> {
    const workspace = await this.store.getSlackWorkspaceByTeamId(teamId);
    return workspace?.enabled ? workspace : null;
  }

  forWorkspace(workspace: SlackWorkspace): SlackClient {
    if (!workspace.enabled) throw new Error("Slack workspace tenant is disabled");
    return this.createClient(this.decryptToken(workspace));
  }

  // Signed lifecycle events can arrive after reprovisioning, even with the
  // same bot user ID. Only a conclusively revoked *current* token authorizes
  // deletion. Disabled tenants still need this check for lifecycle cleanup.
  async tokenIsRevoked(workspace: SlackWorkspace): Promise<boolean> {
    try {
      const identity = await this.createClient(this.decryptToken(workspace)).botIdentity(2_000);
      if (identity.teamId !== workspace.teamId || identity.userId !== workspace.botUserId) {
        throw new Error("Slack workspace identity mismatch");
      }
      return false;
    } catch (error) {
      if (isRevokedSlackToken(error)) return true;
      // No credential, ciphertext or provider response in lifecycle logs.
      throw new Error(`Cannot verify Slack token for workspace ${workspace.teamId}`);
    }
  }

  private decryptToken(workspace: SlackWorkspace): string {
    let token: string;
    try {
      if (!this.encryptionKey) throw new Error("Missing Slack token encryption key");
      token = decryptSlackToken({
        envelope: workspace.botTokenCiphertext,
        teamId: workspace.teamId,
        key: this.encryptionKey,
      });
      if (!token) throw new Error("Empty Slack bot token");
    } catch {
      // Do not retain the crypto error or ciphertext in a cause that a request
      // logger might serialize. Identifiers give operators a safe repair target.
      throw new Error(
        `Slack bot token unavailable for tenant ${workspace.tenantId}, workspace ${workspace.teamId}`,
      );
    }
    return token;
  }

  async forTeam(teamId: string): Promise<{ workspace: SlackWorkspace; client: SlackClient } | null> {
    const workspace = await this.workspaceForTeam(teamId);
    return workspace ? { workspace, client: this.forWorkspace(workspace) } : null;
  }

  async forTenant(tenantId: string): Promise<{ workspace: SlackWorkspace; client: SlackClient } | null> {
    const workspace = await this.store.getSlackWorkspaceByTenantId(tenantId);
    return workspace?.enabled ? { workspace, client: this.forWorkspace(workspace) } : null;
  }
}
