# Vivera in a container: Bun, git, and the skills linked for one non-root user.
#
# NOT VERIFIED: docker, podman and hadolint were absent where this file was written, so no image
# has been built or run. scripts/container.test.mjs checks the file's structure only.
#
# Build and run:  docker build -t vivera . && docker run --rm -it vivera
#
# The base is the Debian variant of the pinned Bun release (apt-get and useradd are used below),
# and the tag follows the "packageManager" field of package.json. A floating tag is never used.
FROM oven/bun:1.4.2-debian AS base

# git is what --tier standard asks for next to bun. The package lists are removed in the same
# RUN so they never reach a layer. /opt/vivera is made for the user here, as root, because WORKDIR
# would create it owned by root and bun install could not write node_modules into it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash vivera \
    && install -d -o vivera -g vivera /opt/vivera

USER vivera
WORKDIR /opt/vivera

# A second stage, so .devcontainer/devcontainer.json can stop at "base" above: it mounts the
# workspace and links that checkout itself, and a copy installed here would leave links the
# installer treats as someone else's and moves aside.
FROM base AS vivera

COPY --chown=vivera:vivera . /opt/vivera

# --ignore-scripts keeps a dependency from downloading a browser at build time. The checkout stays at
# /opt/vivera, so the skills are linked (not copied) from there into the user's home.
RUN bun install --frozen-lockfile --ignore-scripts \
    && ./install.sh --tier standard --only agents

CMD ["bash"]
