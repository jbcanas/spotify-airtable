let request = require('request'); // "Request" library
let SpotifyWebApi = require('spotify-web-api-node');
let Airtable = require('airtable');
let asynclib = require("async");
let lodash = require("lodash");
let moment = require("moment");
const RateLimiter = require('limiter').RateLimiter;
const airtableLimiter = new RateLimiter(5, 'second');
require('dotenv').config();

let spotifyApi = new SpotifyWebApi({
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
});
let base = new Airtable({apiKey: process.env.AIRTABLE_APIKEY}).base('appLwbmOn5lnkXExb');

spotifyApi.clientCredentialsGrant().then(
  function(data) {
    console.log('Logged in!');

    // Save the access token so that it's used in future calls
    spotifyApi.setAccessToken(data.body['access_token']);
  },
  function(err) {
    console.log(
      'Something went wrong when retrieving an access token',
      err.message
    );
  }
);

function asyncTimeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const doRequest = async (args, func, retries) => {
  try {
    if (func === 'searchArtists') return await spotifyApi[func](args, {limit: 1});
    if (func === 'getArtistAlbums') return await spotifyApi[func](args, {include_groups: 'album,single'});
    return await spotifyApi[func](args);
  } catch (e) {
    if (e.statusCode === 429) {
      const seconds = e.headers['retry-after'] ? parseInt(e.headers['retry-after']) * 1001 : 1000;
      await asyncTimeout(seconds);
      return await doRequest(args, func, retries);
    }
    throw e;
  }
};

(async () => {
  await deleteRecords('Albums');
  await deleteRecords('Tracks');
  await processSpotify();
})();

function deleteRecords(table) {
  return base(table).select({
    view: "Grid view"
  }).eachPage(function page(records, fetchNextPage) {
    records.forEach(function(record) {
      airtableLimiter.removeTokens(1, () => {
        record.destroy();
      }, true);
    });

    fetchNextPage();
  }, function done(err) {
    if (err) { console.error(err); return; }
  });
}

function processSpotify() {

  return base('Artists').select({
    view: "Grid view",
    // maxRecords: 1,
  }).eachPage(function page(records, fetchNextPage) {
    records.forEach(function(record) {
      const recordID = record.getId();

      doRequest(record.get('Band Name'), 'searchArtists', 1).then((response) => {
        if (response.body.artists.items.length > 0) {
          let resultArtist = response.body.artists.items[0];

          airtableLimiter.removeTokens(1, () => {
            base('Artists').update(record.getId(), {
              "Spotify ID": resultArtist.id,
              "Spotify URL":resultArtist.external_urls.spotify
            }, function(err) {
              if (err) { console.error(err); }
            });
          }, true);

          doRequest(resultArtist.id, 'getArtistAlbums', 1).then((response) => {
            let albumData = response.body.items;

            asynclib.each(albumData, (album) => {
              airtableLimiter.removeTokens(1, () => {
                if (album.album_type === 'album') {
                    base('Albums').create({
                      "Name": album.name,
                      "Artists": [recordID],
                      "Spotify ID": album.id,
                      "Total Tracks": album.total_tracks,
                      "Release Date": moment(album.release_date, 'YYYY/MM/DD').format('MM/DD/YYYY'),
                      "Spotify URL": album.external_urls.spotify
                    }, (err) => {
                      if (err) {
                        console.error(err);
                      }

                      /*doRequest(album.id, 'getAlbumTracks', 1).then((data) => {
                        asynclib.each(data.body.items, (item) => {
                          airtableLimiter.removeTokens(1, () => {
                            base('AlbumTracks').create({
                              "Name": item.name,
                              "Albums": [albumRecord.getId()],
                              "Spotify ID": item.id,
                              "Spotify URL": item.external_urls.spotify,
                              "Track Number": item.track_number
                            }, (err) => {
                              if (err) { console.error(err); return; }
                            });
                          });
                        });
                      }).catch((err) => {
                        console.log(err);
                      });}*/
                    });
                } else if (album.album_type === 'single') {
                  base('Tracks').create({
                    "Name": album.name,
                    "Artists": [recordID],
                    "Spotify ID": album.id,
                    "Release Date": moment(album.release_date, 'YYYY/MM/DD').format('MM/DD/YYYY'),
                    "Spotify URL": album.external_urls.spotify
                  }, (err) => {
                    if (err) { console.error(err); return; }
                  });
                }
              }, true);
            });
          }).catch((err) => {
            console.log(err);
          });
        }
      }).catch((err) => {
        console.log(err);
      });
    });

    fetchNextPage();
  }, function done(err) {
    if (err) { console.error(err); return; }
  });
}

