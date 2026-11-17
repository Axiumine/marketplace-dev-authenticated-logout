#!/bin/bash

#load nvm
. ~/.nvm/nvm.sh
. ~/.profile
. ~/.bashrc

nvm use v26.13.1
yarn run build # checks for errors
yarn run dev
