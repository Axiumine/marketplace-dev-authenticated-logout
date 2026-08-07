#!/bin/bash

mkdir -p /var/ram/marketplace-authenticated-logout/node_modules
rm -rf node_modules/*
sync
mkdir node_modules
sudo mount --bind /var/ram/marketplace-authenticated-logout/node_modules node_modules  # <--- add to sudoers

#load nvm
. ~/.nvm/nvm.sh
. ~/.profile
. ~/.bashrc

# Version comes from .nvmrc, so it is stated once per repo and cannot drift from
# engines.node the way a hard-coded literal here silently would.
nvm use
node --version
yarn install
yarn run dev

