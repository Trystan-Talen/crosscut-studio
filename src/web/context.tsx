import { createContext, useContext } from "react";
import type {
  Asset,
  Project,
  ProviderPublic,
  Tool,
  User,
} from "../shared/types";
export interface WorkspaceContext {
  user: User;
  tools: Tool[];
  providers: ProviderPublic[];
  projects: Project[];
  assets: Asset[];
  refresh: () => void;
  notify: (text: string) => void;
  setUser: (user: User) => void;
}
export const Context = createContext<WorkspaceContext | null>(null);
export function useWorkspace() {
  const context = useContext(Context);
  if (!context) throw new Error("Workspace context missing");
  return context;
}
