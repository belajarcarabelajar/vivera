# Vivera in a container: Bun, git, and the skills linked for the image's non-root user.
#
# VERIFIED: the docker job of .github/workflows/platforms.yml (ubuntu-latest, Docker) builds the
# default target and runs `./install.sh --check --tier standard --only agents` in the image. It
# passed in runs 40440396551 (main, 07b584b), 40444890219 and 40446225707 (a branch; the last
# printed `check: CURRENT`). That workflow is dispatch-only, so after a change re-check it by hand:
# `gh workflow run platforms.yml`.
# NOT VERIFIED: hadolint was never run on this file, podman was not tried, and the devcontainer
# path (target "base" plus its postCreateCommand) was never built. scripts/container.test.mjs
# checks the file's structure only.
#
# Build and run:  docker build -t vivera . && docker run --rm -it vivera
#
# The base is the Debian variant of the Bun release package.json pins (apt-get is used below). The tag
# pins a Bun patch version, not a digest, so the Debian layer and the apt packages can still change
# between builds.
#
# The user is bun (uid 1000, home /home/bun), which the base image already creates: its registry
# config runs `useradd bun --uid 1000 --create-home`. A second user would get uid 1001, which does
# not match a workspace bind-mounted from a host user with uid 1000.
FROM oven/bun:1.4.2-debian AS base

# git is what --tier standard asks for next to bun. The package lists are removed in the same
# RUN so they never reach a layer. /opt/vivera is made for the user here, as root, because WORKDIR
# would create it owned by root and bun install could not write node_modules into it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o bun -g bun /opt/vivera

USER bun
WORKDIR /opt/vivera

# A second stage, so .devcontainer/devcontainer.json can stop at "base" above: it mounts the
# workspace and links that checkout itself, and a copy installed here would leave links the
# installer treats as someone else's and moves aside.
FROM base AS vivera

# The two manifests first, so the dependency layer is rebuilt only when they change and not on every
# source edit. --ignore-scripts keeps a dependency from running its install scripts at build time (a
# browser download, for one).
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# The checkout stays at /opt/vivera, so the skills are linked (not copied) from there into the user's home.
COPY --chown=bun:bun . /opt/vivera
RUN ./install.sh --tier standard --only agents

# install.sh exiting 0 says it ran; --check says the links it made are the ones it expects.
RUN ./install.sh --check --tier standard --only agents

CMD ["bash"]
