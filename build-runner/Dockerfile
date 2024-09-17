# fetch unbuntu image from docker hub
FROM ubuntu:focal

# install curl and update packages
RUN apt-get update
RUN apt-get install -y curl
RUN curl -sL https://deb.nodesource.com/setup_20.x | bash -
RUN apt-get upgrade -y

# install git and node.js on the image
RUN apt-get install -y nodejs
RUN apt-get install -y git

# set working directory (where our app will be)
WORKDIR /home/app

# copy our files this will go to /home/app (eg main.sh will be at /home/app/main.sh)
COPY main.sh main.sh
COPY script.js script.js
COPY package.json package.json
COPY package-lock.json package-lock.json

# install dependencies
RUN npm install

# set permissions this will give these files permission to execute
RUN chmod +x main.sh
RUN chmod +x script.js

# run the file
ENTRYPOINT [ "/home/app/main.sh" ]