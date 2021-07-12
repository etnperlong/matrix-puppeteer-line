#!/bin/sh

if [ ! -w . ]; then
	echo "Please ensure the /data volume of this container is writable for user:group $UID:$GID." >&2
	exit
fi

if [ ! -f /data/config.json ]; then
	cp example-config-docker.json /data/config.json
	echo "Didn't find a config file."
	echo "Copied default config file to /data/config.json"
	echo "Modify that config file to your liking, then restart the container."
	exit
fi

# Allow setting custom browser path via "executable_path" config setting
# TODO Decide if --no-sandbox is needed
xvfb-run yarn start --config /data/config.json