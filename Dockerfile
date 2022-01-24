FROM nvidia/opengl:1.2-glvnd-runtime-ubuntu20.04

# install curl as we need it to get latest nodejs package
RUN apt-get update
RUN apt-get install -y curl

# set node source
RUN curl -sL https://deb.nodesource.com/setup_14.x -o nodesource_setup.sh
RUN bash nodesource_setup.sh

# install stuff (found it online, x11 = fake window buffer)
RUN DEBIAN_FRONTEND=noninteractive \
  apt-get install -y \
  xorg \
  xserver-xorg \
  xvfb \
  libx11-dev \
  libxext-dev \
  nodejs

# install google chrome because chromium is a pain
RUN curl -LO https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
RUN apt-get install -y ./google-chrome-stable_current_amd64.deb
RUN rm google-chrome-stable_current_amd64.deb 

RUN npm install --global yarn

# tells puppeteer to use the chrome binaries
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome

# instructs the container to have access to all the GPUs
ENV NVIDIA_VISIBLE_DEVICES all
ENV NVIDIA_DRIVER_CAPABILITIES all

# setup modules & project
WORKDIR /app
COPY package.json ./
COPY yarn.lock ./
RUN yarn install
COPY . .