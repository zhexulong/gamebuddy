FROM oven/bun:1.3.10-debian

ARG OPENCODE_VERSION=1.18.3
ENV OPENCODE_VERSION=${OPENCODE_VERSION}

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git jq sqlite3 socat tmux \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://opencode.ai/install | bash -s -- --version "${OPENCODE_VERSION}" \
    && ln -s /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && test "$(opencode --version)" = "${OPENCODE_VERSION}"

COPY entrypoint.sh /usr/local/bin/mc-drive-entrypoint
RUN chmod 0755 /usr/local/bin/mc-drive-entrypoint

ENTRYPOINT ["/usr/local/bin/mc-drive-entrypoint"]
