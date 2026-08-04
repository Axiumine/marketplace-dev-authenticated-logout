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

nvm use v24.18.0
node --version
yarn install
yarn run dev

