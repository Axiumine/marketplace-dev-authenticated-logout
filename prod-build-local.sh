#!/bin/bash

#load nvm
. ~/.nvm/nvm.sh
. ~/.profile
. ~/.bashrc

nvm use "${NODE_VER:-v26.13.1}"
node --version

#install new ?
rm -rf node_modules
sync

yarn install
yarn run build
