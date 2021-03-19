FROM paritytech/pickle_rick:latest
USER root
WORKDIR /root

COPY --from=paritytech/pickle_rick:latest /home/nonroot/gurke /home/nonroot/gurke

# install nodejs 14.0 or >
# https://github.com/nodesource/distributions/blob/master/README.md#installation-instructions
RUN curl -fsSL https://deb.nodesource.com/setup_current.x | bash -
# install the Yarn package manager, copatible with nodejs 14 or >
RUN curl -sL https://dl.yarnpkg.com/debian/pubkey.gpg | apt-key add -
RUN echo "deb https://dl.yarnpkg.com/debian/ stable main" | tee /etc/apt/sources.list.d/yarn.list
RUN apt-get update --fix-missing && \
    apt-get install -y nodejs yarn


WORKDIR /home/nonroot/simnet_scripts

COPY package.json package-lock.json tsconfig.json .
COPY src/ src/

RUN npm install  typescript
# This will generate dist dir which is needed in order for the script to run
RUN npm run build  
# place index.js in a place where gurke expects it
RUN ln -s "$(pwd)"/dist/index.js /usr/local/bin/simnet_scripts

RUN chown -R nonroot. /home/nonroot

# Use the non-root user to run our application
USER nonroot

WORKDIR /home/nonroot/gurke
# Tini allows us to avoid several Docker edge cases, see https://github.com/krallin/tini
ENTRYPOINT ["tini", "--", "bash"]
# Run your program under Tini

