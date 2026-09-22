import { createContext, useContext } from "react";

// Where chat-scoped files and charts are fetched from: "/api" for the owner, "/api/public/<token>" on a
// shared read-only page (the server only serves that chat's files through the token).
export const ApiBase = createContext("/api");

export function useApiBase() {
  return useContext(ApiBase);
}
