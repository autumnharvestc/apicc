FROM node:22.19.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client openssh-server ca-certificates tini && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd
ENTRYPOINT ["/usr/bin/tini", "--"]
