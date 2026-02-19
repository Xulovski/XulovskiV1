const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 3600 }); // Cache tokens por 1 hora

const manifest = {
    id: 'org.stremio.stalker.emulator',
    version: '0.0.1',
    name: 'Stalker Emulator IPTV',
    description: 'Emulador de portais Stalker/MAG para Stremio. Suporta Live TV, VOD, Séries. Configure portal, MAC e device type.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv', 'movie', 'series'],
    idPrefixes: ['stalker:'],
    catalogs: [
        { type: 'tv', id: 'live', name: 'Canais Ao Vivo' },
        { type: 'movie', id: 'vod', name: 'VOD' },
        { type: 'series', id: 'series', name: 'Séries' }
    ],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    }
};

const builder = new addonBuilder(manifest);

// Handler para configuração (pede inputs na instalação do addon)
builder.defineConfigSchema({
    portalUrl: { type: 'text', title: 'Portal URL (ex: http://portal.com/stalker_portal/c/)' },
    mac: { type: 'text', title: 'MAC Address (ex: 00:1A:79:XX:XX:XX)' },
    deviceType: { type: 'text', title: 'Device Type (ex: MAG250, MAG254, MAG322)', default: 'MAG250' },
    username: { type: 'text', title: 'Username (opcional, se portal usar)' },
    password: { type: 'text', title: 'Password (opcional, se portal usar)' }
});

// Função helper para handshake e token (com cache)
async function getToken(config) {
    const cacheKey = `\( {config.portalUrl}_ \){config.mac}`;
    let token = cache.get(cacheKey);
    if (token) return token;

    const portal = config.portalUrl.endsWith('/') ? config.portalUrl : `${config.portalUrl}/`;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux;)',
        'Accept': '*/*',
        'Connection': 'Keep-Alive',
        'X-User-Agent': `Model: ${config.deviceType}; Firmware: 1.0; ImageDesc: 1.0;`
    };

    try {
        // Handshake
        const handshakeUrl = `${portal}server/load.php?type=stb&action=handshake&token=&JsHttpRequest=1-xml`;
        const handshakeRes = await axios.get(handshakeUrl, { headers });
        token = handshakeRes.data.js.token;

        // Get Profile (autenticação com MAC)
        headers.Authorization = `Bearer ${token}`;
        const deviceId = Array.from({length: 13}, () => Math.floor(Math.random() * 16).toString(16).toUpperCase()).join('');
        const profileUrl = `${portal}server/load.php?type=stb&action=get_profile&hd=1&ver=ImageDescription: 0.2.18-r14-pub-250; ImageDate: 18 Nov 2013 21:30:18 GMT+0200; PORTAL version: 5.1.0; API Version: JS API version: 330; STB API version: 134; Player Engine version: 0x566`;
        const profileParams = {
            mac: config.mac.toUpperCase(),
            device_id: deviceId,
            device_id2: deviceId,
            auth_second_step: '1',
            metrics: JSON.stringify({ mac: config.mac, sn: '123456789', model: config.deviceType })
        };
        if (config.username && config.password) {
            profileParams.login = config.username;
            profileParams.password = config.password;
        }
        await axios.get(profileUrl, { headers, params: profileParams });

        cache.set(cacheKey, token);
        return token;
    } catch (error) {
        console.error('Erro no handshake/profile:', error.message);
        throw new Error('Falha na autenticação. Verifique config.');
    }
}

// Catalog Handler
builder.defineCatalogHandler(async (args) => {
    const config = args.config;
    if (!config || !config.portalUrl || !config.mac) throw new Error('Configuração incompleta.');

    const token = await getToken(config);
    const headers = { Authorization: `Bearer ${token}` };
    const portal = config.portalUrl.endsWith('/') ? config.portalUrl : `${config.portalUrl}/`;

    let metas = [];
    try {
        if (args.type === 'tv' && args.id === 'live') {
            // Canais Ao Vivo
            const channelsRes = await axios.get(`${portal}server/load.php?type=itv&action=get_all_channels`, { headers });
            metas = channelsRes.data.js.data.map(ch => ({
                id: `stalker:tv:${ch.id}`,
                type: 'tv',
                name: ch.name,
                poster: ch.logo ? `\( {portal} \){ch.logo}` : 'https://via.placeholder.com/300x450?text=TV',
                description: ch.description || 'Canal ao vivo',
                genres: [ch.tv_genre_id || 'Geral']
            }));
        } else if (args.type === 'movie' && args.id === 'vod') {
            // VOD
            const vodRes = await axios.get(`${portal}server/load.php?type=vod&action=get_ordered_list&sortby=added&not_ended=0&p=1&fav=0&JsHttpRequest=1-xml`, { headers });
            metas = vodRes.data.js.data.map(vod => ({
                id: `stalker:vod:${vod.id}`,
                type: 'movie',
                name: vod.name,
                poster: vod.screenshot_uri ? `\( {portal} \){vod.screenshot_uri}` : 'https://via.placeholder.com/300x450?text=VOD',
                description: vod.description || 'Vídeo sob demanda',
                genres: [vod.genre || 'Geral']
            }));
        } else if (args.type === 'series' && args.id === 'series') {
            // Séries
            const seriesRes = await axios.get(`${portal}server/load.php?type=vod&action=get_ordered_list&movie_id=0&season_id=0&episode_id=0&sortby=added&not_ended=0&p=1&fav=0&JsHttpRequest=1-xml&category=*&genre=*`, { headers });
            metas = seriesRes.data.js.data.map(ser => ({
                id: `stalker:series:${ser.id}`,
                type: 'series',
                name: ser.name,
                poster: ser.screenshot_uri ? `\( {portal} \){ser.screenshot_uri}` : 'https://via.placeholder.com/300x450?text=Series',
                description: ser.description || 'Série',
                genres: [ser.genre || 'Geral']
            }));
        }
    } catch (error) {
        console.error('Erro no catalog:', error.message);
    }

    return { metas };
});

// Meta Handler (detalhes, incluindo EPG para TV)
builder.defineMetaHandler(async (args) => {
    const config = args.config;
    const token = await getToken(config);
    const headers = { Authorization: `Bearer ${token}` };
    const portal = config.portalUrl.endsWith('/') ? config.portalUrl : `${config.portalUrl}/`;
    const [_, type, itemId] = args.id.split(':');

    let meta = { id: args.id, type: args.type, name: 'Desconhecido' };
    try {
        if (type === 'tv') {
            const epgRes = await axios.get(`\( {portal}server/load.php?type=itv&action=get_short_epg&ch_id= \){itemId}`, { headers });
            meta.description = epgRes.data.js.epg.map(e => `${e.start} - ${e.name}`).join('\n') || 'Sem EPG';
        } // Para VOD/Series, adicione mais se precisar
    } catch (error) {
        console.error('Erro no meta:', error.message);
    }
    return { meta };
});

// Stream Handler
builder.defineStreamHandler(async (args) => {
    const config = args.config;
    const token = await getToken(config);
    const headers = { Authorization: `Bearer ${token}` };
    const portal = config.portalUrl.endsWith('/') ? config.portalUrl : `${config.portalUrl}/`;
    const [_, type, itemId] = args.id.split(':');

    let streams = [];
    try {
        let actionType = 'itv';
        let cmd = `ch${itemId}`;
        if (type === 'vod') {
            actionType = 'vod';
            cmd = `movie${itemId}`;
        } else if (type === 'series') {
            // Para séries, fetch episódios - assumindo args.season e args.episode
            const seriesInfo = await axios.get(`\( {portal}server/load.php?type=vod&action=get_seasons&series_id= \){itemId}`, { headers });
            // Lógica simplificada: pegue primeiro episódio ou ajuste
            cmd = seriesInfo.data.js.data[0].episodes[0].cmd; // Ajuste conforme necessidade
        }

        const linkRes = await axios.get(`\( {portal}server/load.php?type= \){actionType}&action=create_link&cmd=${cmd}&series=0&forced_storage=undefined&disable_ad=0&download=0&JsHttpRequest=1-xml`, { headers });
        const streamUrl = linkRes.data.js.cmd.split(' ')[1] || linkRes.data.js.cmd; // Remove ffmpeg prefix se houver

        streams = [{
            url: streamUrl,
            title: `${config.deviceType} Stream`,
            behaviorHints: { notWebReady: false, proxyHeaders: { request: {} } }
        }];
    } catch (error) {
        console.error('Erro no stream:', error.message);
    }

    return { streams };
});

// Inicie o server
const addonInterface = builder.getInterface();
serveHTTP(addonInterface, { port: process.env.PORT || 7000 });
console.log('Addon rodando na porta 7000');
