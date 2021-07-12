#!/bin/sh

if [ ! -w . ]; then
	echo "Please ensure the /data volume of this container is writable for user:group $UID:$GID." >&2
	exit
fi

if [ ! -f /data/config.yaml ]; then
	cp example-config.yaml /data/config.yaml
	echo "Didn't find a config file."
	echo "Copied default config file to /data/config.yaml"
	echo "Modify that config file to your liking."
	echo "Start the container again after that to generate the registration file."
	exit
fi

if [ ! -f /data/registration.yaml ]; then
	if ! python3 -m matrix_puppeteer_line -g -c /data/config.yaml -r /data/registration.yaml; then
		exit
	fi
	echo "Didn't find a registration file."
	echo "Generated one for you."
	echo "Copy that over to Synapse's app service directory."
	exit
fi

python3 -m matrix_puppeteer_line -c /data/config.yaml