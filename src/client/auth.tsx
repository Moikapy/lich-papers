import { createContext, useContext } from "react";
import type { User } from "./api";

export interface AuthState {
  user: User | null;
  loading: boolean;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthState>({ user: null, loading: true, setUser: () => {}, logout: async () => {} });
export const useAuth = () => useContext(AuthContext);
