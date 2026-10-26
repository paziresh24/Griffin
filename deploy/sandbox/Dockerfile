# Griffin's own shell: a disposable box for debug_exec (its default host) so agents run scratch
# commands here instead of as root on a real server. No credentials, no kubeconfig; /root persists.
FROM alpine:3.22
# nodejs + npm: the apps an agent previews (preview_start) are mostly Node ones. chromium + Noto (Persian
# too): the agents' browser (apps/server/src/browser.mjs; it adds these itself to a sandbox built before).
RUN apk add --no-cache openssh-server bash curl ca-certificates python3 py3-pip jq bind-tools iputils \
      netcat-openbsd postgresql-client mariadb-client redis git openssl coreutils nodejs npm \
      chromium font-noto font-noto-arabic
# Extra python packages go to the persisted /root (pip install --user, or copy a wheel in).
COPY entrypoint.sh /entrypoint.sh
EXPOSE 2222
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
