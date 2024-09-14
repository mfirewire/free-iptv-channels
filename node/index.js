const http = require('http');
const https = require('https');
const url = require('url');

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const params = parsedUrl.query;
  const region = (params.region || 'us').toLowerCase().trim();
  const service = params.service;

  // Check if the service parameter is missing
  if (!service) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Error: No service type provided');
  }

  if (service.toLowerCase() === 'pbskids') {
    const pbsKidsOutput = await handlePBSKids();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(pbsKidsOutput);
  }

  const APP_URL = `https://i.mjh.nz/${service}/.app.json`;
  let data;
  try {
    data = await fetchJson(APP_URL);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    return res.end('Error: Failed to fetch data');
  }

  if (service.toLowerCase() === 'pbs') {
    const pbsOutput = formatPbsDataForM3U8(data);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(pbsOutput);
  }

  let channels = {};
  const sort = params.sort || 'name';
  let groupExtractionRequired = false;
  let regionNames = {}; // For Plex, to map region codes to full names

  // Map of region codes to full names for Plex
  const regionNameMap = {
    us: "USA",
    mx: "Mexico",
    es: "Spain",
    ca: "Canada",
    au: "Australia",
    nz: "New Zealand"
  };

  if (data.channels) {
    // Channels are directly in the data object, and group extraction is needed
    channels = data.channels;
 
	// Plex-specific genre mapping when region is NOT 'all'
	if (service.toLowerCase() === 'plex' && region !== 'all') {
	  const channelsJsonUrl = 'https://raw.githubusercontent.com/dtankdempse/free-iptv-channels/main/plex/channels.json';
	  let plexChannels;
	  try {
		plexChannels = await fetchJson(channelsJsonUrl);
	  } catch (error) {
		res.writeHead(500, { 'Content-Type': 'text/plain' });
		return res.end('Error: Failed to fetch Plex channels');
	  }

	  channels = Object.keys(channels).reduce((filteredChannels, key) => {
		const channel = channels[key];
		if (channel.regions && channel.regions.includes(region)) {
		  // Search for the channel in the Plex channels JSON by title
		  const plexChannel = plexChannels.find(ch => ch.Title === channel.name);

		  // Use the genre from the Plex channels JSON for group-title, default to "Uncategorized"
		  const genre = plexChannel && plexChannel.Genre ? plexChannel.Genre : 'Uncategorized';
		  
		  // Assign the genre to the group-title
		  filteredChannels[key] = { 
			...channel, 
			group: `${genre}`
		  };
		}
		return filteredChannels;
	  }, {});
	}

	// Region mapping when region is "all"
	if (service.toLowerCase() === 'plex' && region === 'all') {
	  channels = Object.keys(channels).reduce((filteredChannels, key) => {
		const channel = channels[key];
		if (channel.regions && channel.regions.length > 0) {
		  channel.regions.forEach(regionCode => {
			const regionFullName = regionNameMap[regionCode] || regionCode.toUpperCase();
			
			// Assign the region name as the group-title
			filteredChannels[key] = {
			  ...channel,
			  group: `${regionFullName}`
			};
		  });
		}
		return filteredChannels;
	  }, {});
	}

    groupExtractionRequired = true;
  } else if (data.regions) {
    // Channels are inside regions, no special group extraction needed
    const regions = data.regions;

    if (service.toLowerCase() === 'plex') {
      for (let regionKey in regions) {
        regionNames[regionKey] = regionNameMap[regionKey] || regionKey.toUpperCase();
      }
    }

	if (region === 'all') {
	  for (let regionKey in regions) {
		for (let channelKey in regions[regionKey].channels) {
		  const regionChannel = { ...regions[regionKey].channels[channelKey], region: regions[regionKey].name || regionKey.toUpperCase() };

		  // Generate a unique channelId for each region to avoid overwriting
		  const uniqueChannelId = `${channelKey}-${regionKey}`;
		  
		  channels[uniqueChannelId] = regionChannel;
		}
	  }
	} else if (regions[region]) {
      channels = regions[region].channels || {};
    } else {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end(`Error: Invalid region ${region}`);
    }
  } else {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Error: Invalid data format');
  }

  const startChno = params.start_chno ? parseInt(params.start_chno) : null;
  const include = (params.include || '').split(',').filter(Boolean);
  const exclude = (params.exclude || '').split(',').filter(Boolean);

  let output = `#EXTM3U url-tvg="https://github.com/matthuisman/i.mjh.nz/raw/master/${service}/${region}.xml.gz"\n`;

  if (service.toLowerCase() === 'roku') {
    output = `#EXTM3U url-tvg="https://github.com/matthuisman/i.mjh.nz/raw/master/roku/all.xml.gz"\n`;
  }

  const sortedKeys = Object.keys(channels).sort((a, b) => {
    const chA = channels[a];
    const chB = channels[b];
     return sort === 'chno' ? (chA.chno - chB.chno) : chA.name.localeCompare(chB.name);
  });

  sortedKeys.forEach(key => {
    const channel = channels[key];
    const { logo, name, url, regions } = channel; 
    const channelId = `${service}-${key}`;

    let group = groupExtractionRequired ? (channel.group || '') : (channel.group || '');

    if (service.toLowerCase() === 'roku') {
      group = '';
    }

    if (service.toLowerCase() === 'plex' && region === 'all' && regions && regions.length > 0) {
      regions.forEach(regionCode => {
        const regionFullName = regionNameMap[regionCode] || regionCode.toUpperCase();

        if (!channel.license_url && (!include.length || include.includes(channelId)) && !exclude.includes(channelId)) {
          let chno = '';
          if (startChno !== null) {
            chno = ` tvg-chno="${startChno}"`;
            startChno++;
          } else if (channel.chno) {
            chno = ` tvg-chno="${channel.chno}"`;
          }

          output += `#EXTINF:-1 channel-id="${channelId}" tvg-id="${key}" tvg-logo="${logo}" group-title="${regionFullName}"${chno},${name}\n${url}\n`;
        }
      });
    } else {
      if ((service.toLowerCase() === 'samsungtvplus' || service.toLowerCase() === 'plutotv') && region === 'all' && channel.region) {
        group = channel.region;
      } else if (region === 'all' && channel.region) {
        const regionCode = channel.region ? channel.region.toUpperCase() : '';
        if (regionCode) {
          group += ` (${regionCode})`;
        }
      }

      if (!channel.license_url && (!include.length || include.includes(channelId)) && !exclude.includes(channelId)) {
        let chno = '';
        if (startChno !== null) {
          chno = ` tvg-chno="${startChno}"`;
          startChno++;
        } else if (channel.chno) {
          chno = ` tvg-chno="${channel.chno}"`;
        }

        output += `#EXTINF:-1 channel-id="${channelId}" tvg-id="${key}" tvg-logo="${logo}" group-title="${group}"${chno},${name}\n${url}\n`;
      }
    }
  });

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(output);
});

// Fetch JSON data from the provided URL
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

// Handle PBS Kids
async function handlePBSKids() {
  const APP_URL = 'https://i.mjh.nz/PBS/.kids_app.json';
  const EPG_URL = 'https://github.com/matthuisman/i.mjh.nz/raw/master/PBS/kids_all.xml.gz';
  
  try {
    const data = await fetchJson(APP_URL);
    let output = `#EXTM3U url-tvg="${EPG_URL}"\n`;

    const sortedKeys = Object.keys(data.channels).sort((a, b) => {
      return data.channels[a].name.toLowerCase().localeCompare(data.channels[b].name.toLowerCase());
    });

    sortedKeys.forEach(key => {
      const channel = data.channels[key];
      output += `#EXTINF:-1 channel-id="pbskids-${key}" tvg-id="${key}" tvg-logo="${channel.logo}", ${channel.name}\n${channel.url}\n`;
    });

    return output;
  } catch (error) {
    return 'Error fetching PBS Kids data: ' + error.message;
  }
}

// Format PBS data for M3U8
function formatPbsDataForM3U8(data) {
  let output = '#EXTM3U x-tvg-url="https://github.com/matthuisman/i.mjh.nz/raw/master/PBS/all.xml.gz"\n';

  Object.keys(data.channels).forEach(key => {
    const channel = data.channels[key];
    output += `#EXTINF:-1 channel-id="pbs-${key}" tvg-id="${key}" tvg-logo="${channel.logo}", ${channel.name}\n`;
    output += `#KODIPROP:inputstream.adaptive.manifest_type=mpd\n`;
    output += `#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha\n`;
    output += `#KODIPROP:inputstream.adaptive.license_key=${channel.license}|Content-Type=application%2Foctet-stream&user-agent=okhttp%2F4.9.0|R{SSM}|\n`;
    output += `${channel.url}|user-agent=okhttp%2F4.9.0\n`;
  });

  return output;
}

server.listen(3000, () => {
  console.log('Server running at http://localhost:3000/');
});
