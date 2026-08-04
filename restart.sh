#!/bin/bash

#load nvm
. ~/.nvm/nvm.sh
. ~/.profile
. ~/.bashrc

nvm use v24.18.0
yarn run build # checks for errors
yarn run dev
