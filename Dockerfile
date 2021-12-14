FROM nvidia/opengl:1.2-glvnd-runtime-ubuntu20.04

RUN apt-get update
RUN apt-get install -y curl

RUN curl -sL https://deb.nodesource.com/setup_14.x -o nodesource_setup.sh
RUN bash nodesource_setup.sh

RUN DEBIAN_FRONTEND=noninteractive \
  apt-get install -y \
  xorg \
  xserver-xorg \
  xvfb \
  libx11-dev \
  libxext-dev \
  nodejs

RUN curl -LO https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
RUN apt-get install -y ./google-chrome-stable_current_amd64.deb
RUN rm google-chrome-stable_current_amd64.deb 

RUN npm install --global yarn

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome

WORKDIR /app
COPY package.json ./
RUN yarn install

COPY . .

# FAILS
# CMD [ "node", "index.js", "--cid", "QmSCdcydNEvsJXf6oeggASxe6FsgdxHBZWgnWKYDNJK9Tr", "--mode", "CANVAS", "--delay", "120000", "--selector", "canvas#defaultCanvas0" ]
CMD [ "node", "index.js", "--cid", "QmR6tgYH24GhebBaNp3xwA6Lvb2HFkVaLt7os2sZjCFJQA", "--mode", "VIEWPORT", "--delay", "2000", "--resX", "700", "--resY", "2000" ]