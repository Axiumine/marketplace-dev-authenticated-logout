#!/bin/bash

##########################################
# DO NOT CALL DIRECTLY
#  call with service groupayappbe start
##########################################


#load nvm
. ~/.nvm/nvm.sh
. ~/.profile
. ~/.bashrc

nvm use v24.18.0
node --version

yarn run start
