import type { ResourceRequest } from './deployment-plan';
export interface ConnectionStatus {
  github: {
    configured: boolean;
    connected: boolean;
    installUrl: string | null;
  };
  cloudflare: {
    configured: boolean;
    connected: boolean;
    account: { id: string; name: string } | null;
  };
  nativeBuildsEnabled: boolean;
  // Whether GitHub Actions can deploy pushes: GitHub's runners can't reach a Shipcel on
  // someone's own computer.
  githubActions?: boolean;
}
export interface SessionStatus {
  user: {
    login: string;
    workspaceId: string;
    local: boolean;
    role: 'owner' | 'developer' | 'viewer';
    workspaces: {
      id: string;
      name: string;
      role: 'owner' | 'developer' | 'viewer';
      kind: 'personal' | 'team';
    }[];
  } | null;
  githubConfigured: boolean;
  local: boolean;
}
export interface RepoChoice {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}
export interface Deployment {
  id: string;
  project_id: string;
  repository_name: string;
  branch: string;
  commit_sha?: string;
  recovery_note?: string | null;
  environment?: 'production' | 'preview';
  adapter?: string;
  // Deployed from a computer by Wrangler: the adapter the app was reviewed with.
  localAdapter?: string | null;
  resources?: ResourceRequest[];
  observedResources?: (ResourceRequest & { id: string })[];
  worker_name: string;
  status: string;
  step: string;
  error: string | null;
  account_id: string;
  trigger_uuid: string | null;
  build_uuid: string | null;
  live_url: string | null;
  created_at: number;
  updated_at: number;
}
