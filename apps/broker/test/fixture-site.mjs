// The inventory the broker tests run against. The shipped code knows no clusters, routers or
// buckets of its own, so every test declares the site it is pretending to run in.
export const TEST_SITE = {
  clusters: {
    prod: { api: "https://k8s.example.com", grafana: "https://grafana.example.com", emergency: { host: "203.0.113.10", port: 22, user: "root", kubectl: "kubectl" } },
    edge: { api: "https://k8s-edge.example.com", grafana: "https://grafana-edge.example.com", emergency: { host: "203.0.113.20", port: 2222, user: "root", kubectl: "k0s kubectl" } },
    dr: { api: "https://k8s-dr.example.com", grafana: "https://grafana-dr.example.com", emergency: { host: "203.0.113.30", port: 22, user: "root", kubectl: "kubectl" } },
  },
  gitlab: { url: "https://gitlab.example.com" },
  s3: { cluster: "prod", endpoint: "https://s3.example.com", region: "us-east-1", secret: { namespace: "storage", name: "s3-credentials" } },
  debugHosts: { debug: { host: "203.0.113.40", port: 22, user: "root" } },
  routers: {
    gateway: { label: "test gateway", vaultSlug: "mikrotik-gateway__api", publicAddress: "198.51.100.1", lan: "10.0.0.0/24", writableLists: ["edge-allowlist"] },
    office: {
      label: "test office router",
      infisical: { project: "p", path: "/x", host: "MT_HOST", user: "MT_USER", password: "MT_PASS" },
      lan: null,
      writableLists: [],
      transport: "winbox",
      port: 8291,
    },
  },
};
