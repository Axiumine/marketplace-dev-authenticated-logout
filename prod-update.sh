#!/bin/bash

#load nvm
. ~/.nvm/nvm.sh
. ~/.profile
. ~/.bashrc

node --version

hg pull
hg update --verbose --clean -r tip
rm -rf node_modules
sync

yarn install
yarn run build
