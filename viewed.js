/*
 * TorrServer Viewed — плагин для Lampa.
 *
 * Показывает в списке файлов торрента (встроенный клиент TorrServer) серии,
 * отмеченные просмотренными в самом TorrServer (POST /viewed), и сам ставит
 * отметку, когда серия запускается из Lampa. Так отметки совпадают
 * с веб-интерфейсом TorrServer и другими клиентами.
 *
 * Адрес сервера и логин/пароль берутся из настроек Lampa (Настройки → TorrServer):
 * запросы идут через Lampa.Reguest, который сам добавляет Basic-авторизацию.
 */
(function () {
    'use strict';

    if (window.torrserver_viewed_plugin) return;
    window.torrserver_viewed_plugin = true;

    var network = new Lampa.Reguest();

    // Текущий открытый список файлов
    var current = {
        hash: '',
        items: {},     // file id -> {element, item}
        viewed: {},    // file id -> true
        loaded: false
    };

    // Ожидающий длинного нажатия файл (для синхронизации пунктов «Сбросить»/«Просмотрено» самой Lampa)
    var pending_long = null;

    function enabled(name) {
        return Lampa.Storage.field(name) !== false;
    }

    function serverUrl() {
        return Lampa.Torserver && Lampa.Torserver.url ? Lampa.Torserver.url() : '';
    }

    function request(data, success, fail) {
        var url = serverUrl();

        if (!url) return fail && fail();

        network.timeout(5000);
        network.silent(url + '/viewed', success || function () {}, fail || function () {}, JSON.stringify(data));
    }

    function load(hash, call) {
        request({ action: 'list', hash: hash }, function (json) {
            call(Array.isArray(json) ? json : []);
        }, function () {
            call([]);
        });
    }

    function setViewed(hash, file_index, state) {
        if (!hash || !file_index) return;

        request({ action: state ? 'set' : 'rem', hash: hash, file_index: file_index });

        if (hash == current.hash) {
            if (state) current.viewed[file_index] = true;
            else delete current.viewed[file_index];

            paint(file_index);
        }
    }

    // Рисует значок/приглушение у одного файла
    function paint(file_index) {
        var entry = current.items[file_index];

        if (!entry) return;

        var item = entry.item;
        var view = entry.element.timeline || {};
        var is_viewed = !!current.viewed[file_index];
        var percent = Math.round(view.percent || 0);

        item.toggleClass('tsv--viewed', is_viewed && enabled('tsv_dim'));
        item.find('.tsv-badge').remove();

        var text = '';
        var cls = '';

        if (is_viewed && percent > 0 && percent < 95) {
            text = '✓ ' + percent + '%';
            cls = ' tsv-badge--viewed';
        } else if (is_viewed) {
            text = '✓ ' + Lampa.Lang.translate('tsv_viewed');
            cls = ' tsv-badge--viewed';
        } else if (percent > 0) {
            text = percent + '%';
        }

        if (!text) return;

        var badge = $('<span class="tsv-badge' + cls + '"></span>').text(text);
        var title = item.find('.torrent-serial__title, .torrent-file__title').eq(0);

        if (title.length) title.prepend(badge);
        else item.prepend(badge);
    }

    function paintAll() {
        for (var id in current.items) paint(id);
    }

    function reset() {
        current = { hash: '', items: {}, viewed: {}, loaded: false };
        pending_long = null;
    }

    function onTorrentFile(e) {
        if (e.type == 'list_open') {
            reset();

            // Если в Lampa включён TrackTimecode, список отметок она уже получила сама
            if (e.params && e.params.viewed && e.params.viewed.length) {
                e.params.viewed.forEach(function (v) {
                    current.viewed[v.file_index] = true;
                });
                current.loaded = true;
            }
        } else if (e.type == 'render') {
            var element = e.element;

            current.items[element.id] = { element: element, item: e.item };

            remember(element, e.items ? e.items.length : 0);

            if (!current.hash) {
                current.hash = element.torrent_hash;

                if (!current.loaded) {
                    var hash = current.hash;

                    load(hash, function (list) {
                        if (hash !== current.hash) return;

                        list.forEach(function (v) {
                            current.viewed[v.file_index] = true;
                        });

                        current.loaded = true;

                        paintAll();
                    });
                }
            }

            paint(element.id);
        } else if (e.type == 'onenter') {
            pending_long = null;
        } else if (e.type == 'onlong') {
            var el = e.element;
            var is_viewed = !!current.viewed[el.id];
            var back = Lampa.Controller.enabled().name;

            pending_long = { hash: el.timeline ? el.timeline.hash : '', element: el, time: Date.now() };

            e.menu.push({
                title: is_viewed ? Lampa.Lang.translate('tsv_unmark') : Lampa.Lang.translate('tsv_mark'),
                onSelect: function () {
                    pending_long = null;

                    setViewed(el.torrent_hash, el.id, !is_viewed);

                    Lampa.Controller.toggle(back);
                }
            });
        } else if (e.type == 'list_close') {
            reset();

            // Вернулись из списка файлов — обновляем значки на «Моих торрентах»
            setTimeout(myCardsPaintAll, 500);
        }
    }

    // Пункты самой Lampa «Сбросить таймкод» / «Отметить как просмотренное» меняют timeline:
    // переносим это в TorrServer
    function onTimeline(e) {
        if (!pending_long || !e.data || e.data.hash !== pending_long.hash) return;
        if (Date.now() - pending_long.time > 60000) return (pending_long = null);

        var el = pending_long.element;
        var road = e.data.road || {};

        pending_long = null;

        if (road.percent >= 100) {
            setViewed(el.torrent_hash, el.id, true);
        } else if (!road.percent && !road.time) {
            // При включённом TrackTimecode Lampa сама шлёт set с timecode 0 — снимаем отметку после неё
            setTimeout(function () {
                setViewed(el.torrent_hash, el.id, false);
            }, 700);
        }
    }

    // Запуск серии: из списка, переключение по плейлисту в плеере, внешний плеер
    function onPlayerStart(data) {
        if (!data || !data.torrent_hash) return;

        rememberLast(data);

        if (!enabled('tsv_mark_on_start')) return;

        var id = data.id;

        if (!id && data.url) {
            var m = String(data.url).match(/[?&]index=(\d+)/);
            if (m) id = parseInt(m[1], 10);
        }

        if (id) setViewed(data.torrent_hash, id, true);
    }

    /*
     * Память о торрентах: TorrServer по хешу знает только номера просмотренных файлов,
     * а какой файл какая серия — плагин запоминает сам, когда Lampa показывает список файлов.
     * tsv_watch = { hash: { card, total, files: { file_index: [season, episode, name] }, last: {index, time}, time } }
     */
    var watch_save_timer;

    function watchData() {
        var data = Lampa.Storage.get('tsv_watch', '{}');

        return data && typeof data == 'object' ? data : {};
    }

    function watchSave(data) {
        var hashes = Object.keys(data);

        // Храним не больше 500 торрентов: выбрасываем те, что давно не открывались
        if (hashes.length > 500) {
            hashes.sort(function (a, b) { return (data[a].time || 0) - (data[b].time || 0); });
            hashes.slice(0, hashes.length - 500).forEach(function (h) { delete data[h]; });
        }

        Lampa.Storage.set('tsv_watch', data);
    }

    function watchTorrent(data, hash, card) {
        if (!data[hash] || typeof data[hash] !== 'object') data[hash] = { total: 0, files: {} };

        data[hash].time = Date.now();

        if (card && card.id) data[hash].card = card.id;

        return data[hash];
    }

    var pending_files = {};

    function remember(element, total) {
        var hash = element.torrent_hash;

        if (!hash) return;

        pending_files[element.id] = [element.season || 0, element.episode || 0, element.fname || element.title || ''];

        clearTimeout(watch_save_timer);

        watch_save_timer = setTimeout(function () {
            var data = watchData();
            var torrent = watchTorrent(data, hash, element.card);

            torrent.total = total;

            for (var id in pending_files) torrent.files[id] = pending_files[id];

            pending_files = {};

            watchSave(data);
        }, 100);
    }

    function rememberLast(data) {
        var id = data.id;

        if (!data.torrent_hash || !id) return;

        var all = watchData();
        var torrent = watchTorrent(all, data.torrent_hash, data.card);

        torrent.last = { index: id, time: Date.now() };

        if (!torrent.files[id]) torrent.files[id] = [data.season || 0, data.episode || 0, data.fname || data.title || ''];

        watchSave(all);
    }

    // Инфохеш раздачи из результата парсера (поле InfoHash или magnet-ссылка, hex или base32)
    function infoHash(element) {
        if (element.InfoHash && /^[a-f0-9]{40}$/i.test(element.InfoHash)) return element.InfoHash.toLowerCase();

        var link = element.MagnetUri || element.Link || '';
        var m = String(link).match(/btih:([a-z0-9]+)/i);

        if (!m) return '';

        var h = m[1];

        if (h.length == 40) return h.toLowerCase();

        if (h.length == 32) {
            var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
            var bits = '';
            var hex = '';

            h.toUpperCase().split('').forEach(function (c) {
                bits += ('00000' + alphabet.indexOf(c).toString(2)).slice(-5);
            });

            for (var i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.substr(i, 4), 2).toString(16);

            return hex;
        }

        return '';
    }

    function episodeLabel(file) {
        if (!file) return '';

        var parts = [];

        if (file[1]) {
            if (file[0]) parts.push(Lampa.Lang.translate('tsv_season') + ' ' + file[0]);
            parts.push(Lampa.Lang.translate('tsv_episode') + ' ' + file[1]);
        }

        var text = parts.join(', ');

        if (file[2] && !/^\d+$/.test(file[2])) text += (text ? ' — ' : '') + '«' + file[2] + '»';

        return text;
    }

    // Сводка по одной раздаче: сколько просмотрено и какая серия текущая
    function summary(torrent, viewed) {
        var files = (torrent && torrent.files) || {};
        var current_index = 0;

        if (torrent && torrent.last && torrent.last.index) current_index = torrent.last.index;
        else {
            // Последнего запуска не знаем (смотрели с другого клиента) — берём самую дальнюю просмотренную серию
            var best = null;

            viewed.forEach(function (idx) {
                var f = files[idx];

                if (!f) return;

                var key = f[0] * 10000 + f[1];

                if (!best || key > best.key) best = { key: key, idx: idx };
            });

            if (best) current_index = best.idx;
        }

        return {
            viewed: viewed.length,
            total: torrent ? torrent.total : 0,
            current: current_index ? files[current_index] : null,
            time: torrent && torrent.last ? torrent.last.time : 0
        };
    }

    function summaryText(s, short) {
        var text = [];
        var ep = episodeLabel(s.current);

        if (ep) text.push((short ? '' : Lampa.Lang.translate('tsv_watching') + ': ') + (short ? ep.split(' — ')[0] : ep));

        if (s.viewed) text.push(Lampa.Lang.translate('tsv_viewed') + ' ' + s.viewed + (s.total ? ' / ' + s.total : ''));

        return text.join(' · ');
    }

    // Экран «Торренты» карточки
    var screen = {
        activity: null,
        card_id: 0,
        hashes: {},     // hash -> summary
        items: [],      // [{element, item}]
        loaded: false
    };

    function screenPaintItem(entry) {
        var hash = infoHash(entry.element);
        var s = hash && screen.hashes[hash];

        entry.item.find('.tsv-torrent-badge').remove();

        if (!s || (!s.viewed && !s.current)) return;

        var badge = $('<div class="tsv-torrent-badge"></div>').text('✓ ' + summaryText(s, true));

        entry.item.find('.torrent-item__title').after(badge);
    }

    function screenPaintHeader(scroll_body) {
        if (!scroll_body || !scroll_body.length) return;

        scroll_body.find('> .tsv-card-info').remove();

        var best = null;

        for (var h in screen.hashes) {
            var s = screen.hashes[h];

            if (!s.viewed && !s.current) continue;

            if (!best || s.time > best.time || (s.time == best.time && s.viewed > best.viewed)) best = s;
        }

        if (!best) return;

        var info = $('<div class="tsv-card-info"><div class="tsv-card-info__label"></div><div class="tsv-card-info__text"></div></div>');

        info.find('.tsv-card-info__label').text('TorrServer');
        info.find('.tsv-card-info__text').text(summaryText(best, false));

        scroll_body.prepend(info);
    }

    function screenPaint() {
        if (!screen.loaded) return;

        // После фильтрации Lampa перерисовывает список: старые элементы уже не в документе
        screen.items = screen.items.filter(function (entry) { return document.body.contains(entry.item[0]); });
        screen.items.forEach(screenPaintItem);

        if (screen.items.length) screenPaintHeader(screen.items[0].item.parent());
    }

    function screenLoad(card) {
        var card_id = card.id;
        var local = watchData();
        var hashes = {};

        for (var h in local) if (local[h] && local[h].card == card_id) hashes[h] = true;

        var finish = function () {
            var list = Object.keys(hashes);
            var left = list.length;

            if (!left) {
                screen.loaded = true;
                return;
            }

            list.forEach(function (hash) {
                load(hash, function (viewed) {
                    if (screen.card_id !== card_id) return;

                    screen.hashes[hash] = summary(local[hash], viewed.map(function (v) { return v.file_index; }));

                    if (--left == 0) {
                        screen.loaded = true;
                        screenPaint();
                    }
                });
            });
        };

        // Раздачи, добавленные в TorrServer из Lampa, хранят id карточки в поле data
        var url = serverUrl();

        if (!url) return finish();

        network.timeout(5000);
        network.silent(url + '/torrents', function (list) {
            if (Array.isArray(list)) {
                list.forEach(function (t) {
                    try {
                        var d = typeof t.data == 'string' ? JSON.parse(t.data) : t.data;

                        if (d && d.movie && d.movie.id == card_id) hashes[t.hash] = true;
                    } catch (e) {}
                });
            }

            finish();
        }, finish, JSON.stringify({ action: 'list' }));
    }

    // Экран «Мои торренты»: значок на постере каждой раздачи
    function myCardPaint(card_el) {
        var data = card_el.card_data;

        if (!data || typeof data.stat == 'undefined' || !/^[a-f0-9]{40}$/i.test(data.hash || '')) return;

        var hash = data.hash.toLowerCase();

        load(hash, function (viewed) {
            var s = summary(watchData()[hash], viewed.map(function (v) { return v.file_index; }));
            var view = $(card_el).find('.card__view');

            view.find('.tsv-card-badge').remove();

            if (!s.viewed && !s.current) return;

            var badge = $('<div class="tsv-card-badge"></div>');
            var f = s.current;

            if (f && f[1]) {
                $('<div class="tsv-card-badge__ep"></div>')
                    .text((f[0] > 1 ? Lampa.Lang.translate('tsv_season') + ' ' + f[0] + ', ' : '') + Lampa.Lang.translate('tsv_episode') + ' ' + f[1])
                    .appendTo(badge);
            }

            if (s.viewed) $('<div></div>').text('✓ ' + s.viewed + (s.total ? ' / ' + s.total : '')).appendTo(badge);

            view.append(badge);
        });
    }

    function myCardsPaintAll() {
        if (!enabled('tsv_mytorrents')) return;

        $('.card').each(function () {
            if (this.card_data && this.card_data.hash) myCardPaint(this);
        });
    }

    function myCardsObserve() {
        if (!window.MutationObserver) return;

        new MutationObserver(function (mutations) {
            if (!enabled('tsv_mytorrents')) return;

            var active = Lampa.Activity.active();

            if (!active || active.component !== 'mytorrents') return;

            mutations.forEach(function (m) {
                for (var i = 0; i < m.addedNodes.length; i++) {
                    var node = m.addedNodes[i];

                    if (node.nodeType !== 1) continue;

                    if (node.classList.contains('card')) myCardPaint(node);
                    else if (node.querySelectorAll) Array.prototype.forEach.call(node.querySelectorAll('.card'), myCardPaint);
                }
            });
        }).observe(document.body, { childList: true, subtree: true });
    }

    function onTorrent(e) {
        if (e.type !== 'render' || !enabled('tsv_card_info')) return;

        var active = Lampa.Activity.active();
        var card = active && active.movie;

        if (!card || !card.id) return;

        if (screen.activity !== active) {
            screen = { activity: active, card_id: card.id, hashes: {}, items: [], loaded: false };

            screenLoad(card);
        }

        var entry = { element: e.element, item: e.item };

        screen.items.push(entry);

        // Lampa добавляет элемент в список уже после события render
        if (screen.loaded) setTimeout(function () {
            screenPaintItem(entry);

            if (!e.item.parent().find('> .tsv-card-info').length) screenPaintHeader(e.item.parent());
        }, 0);
    }

    function addLang() {
        Lampa.Lang.add({
            tsv_viewed: { ru: 'просмотрено', uk: 'переглянуто', en: 'watched' },
            tsv_mark: { ru: 'TorrServer: отметить просмотренной', uk: 'TorrServer: позначити переглянутою', en: 'TorrServer: mark as watched' },
            tsv_unmark: { ru: 'TorrServer: снять отметку просмотра', uk: 'TorrServer: зняти позначку перегляду', en: 'TorrServer: unmark watched' },
            tsv_mark_on_start: { ru: 'Отмечать серию при запуске', uk: 'Позначати серію при запуску', en: 'Mark episode on start' },
            tsv_mark_on_start_descr: { ru: 'Плагин TorrServer Viewed: ставит отметку «просмотрено» в TorrServer, когда файл запускается из Lampa', uk: 'Плагін TorrServer Viewed: ставить позначку «переглянуто» в TorrServer при запуску файлу з Lampa', en: 'TorrServer Viewed plugin: marks the file as watched in TorrServer when it is played from Lampa' },
            tsv_season: { ru: 'сезон', uk: 'сезон', en: 'season' },
            tsv_episode: { ru: 'серия', uk: 'серія', en: 'episode' },
            tsv_watching: { ru: 'Смотрите', uk: 'Дивитесь', en: 'Watching' },
            tsv_card_info: { ru: 'Текущая серия в списке торрентов', uk: 'Поточна серія у списку торрентів', en: 'Current episode in torrent list' },
            tsv_card_info_descr: { ru: 'Плагин TorrServer Viewed: на экране «Торренты» карточки показывать, какую серию вы смотрите и сколько просмотрено', uk: 'Плагін TorrServer Viewed: на екрані «Торренти» картки показувати поточну серію і скільки переглянуто', en: 'TorrServer Viewed plugin: show the current episode and watched count on the card torrents screen' },
            tsv_mytorrents: { ru: 'Серии на карточках «Мои торренты»', uk: 'Серії на картках «Мої торренти»', en: 'Episodes on «My torrents» cards' },
            tsv_mytorrents_descr: { ru: 'Плагин TorrServer Viewed: на постерах в «Моих торрентах» показывать текущую серию и сколько просмотрено', uk: 'Плагін TorrServer Viewed: на постерах у «Моїх торрентах» показувати поточну серію і скільки переглянуто', en: 'TorrServer Viewed plugin: show the current episode and watched count on «My torrents» posters' },
            tsv_dim: { ru: 'Приглушать просмотренные', uk: 'Приглушувати переглянуті', en: 'Dim watched files' },
            tsv_dim_descr: { ru: 'Плагин TorrServer Viewed: просмотренные файлы в списке торрента показываются бледнее', uk: 'Плагін TorrServer Viewed: переглянуті файли у списку торрента блідіші', en: 'TorrServer Viewed plugin: watched files are dimmed in the torrent file list' }
        });
    }

    function addSettings() {
        if (!Lampa.SettingsApi) return;

        Lampa.SettingsApi.addParam({
            component: 'server',
            param: { name: 'tsv_mark_on_start', type: 'trigger', default: true },
            field: { name: Lampa.Lang.translate('tsv_mark_on_start'), description: Lampa.Lang.translate('tsv_mark_on_start_descr') }
        });

        Lampa.SettingsApi.addParam({
            component: 'server',
            param: { name: 'tsv_card_info', type: 'trigger', default: true },
            field: { name: Lampa.Lang.translate('tsv_card_info'), description: Lampa.Lang.translate('tsv_card_info_descr') }
        });

        Lampa.SettingsApi.addParam({
            component: 'server',
            param: { name: 'tsv_mytorrents', type: 'trigger', default: true },
            field: { name: Lampa.Lang.translate('tsv_mytorrents'), description: Lampa.Lang.translate('tsv_mytorrents_descr') },
            onChange: function () {
                if (enabled('tsv_mytorrents')) myCardsPaintAll();
                else $('.tsv-card-badge').remove();
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'server',
            param: { name: 'tsv_dim', type: 'trigger', default: true },
            field: { name: Lampa.Lang.translate('tsv_dim'), description: Lampa.Lang.translate('tsv_dim_descr') }
        });
    }

    function addStyle() {
        var css = '' +
            '.tsv--viewed:not(.focus) { opacity: 0.55; }' +
            '.tsv-badge { display: inline-block; margin-right: 0.6em; padding: 0.1em 0.5em; border-radius: 0.3em; font-size: 0.8em; line-height: 1.4; vertical-align: middle; background: rgba(255,255,255,0.15); }' +
            '.tsv-badge--viewed { background: #3b9a4b; color: #fff; }' +
            '.focus .tsv-badge { background: rgba(0,0,0,0.15); }' +
            '.focus .tsv-badge--viewed { background: #2d7d3b; color: #fff; }' +
            '.tsv-card-info { display: flex; align-items: center; margin: 0 0 1em; padding: 0.8em 1.2em; border-radius: 0.6em; background: rgba(59,154,75,0.18); font-size: 1.2em; }' +
            '.tsv-card-info__label { flex-shrink: 0; margin-right: 1em; padding: 0.15em 0.6em; border-radius: 0.3em; background: #3b9a4b; color: #fff; font-size: 0.8em; }' +
            '.tsv-card-badge { position: absolute; left: 0.5em; right: 0.5em; bottom: 0.5em; z-index: 2; padding: 0.3em 0.6em; border-radius: 0.4em; background: rgba(40,130,60,0.92); color: #fff; font-size: 0.95em; line-height: 1.35; text-align: center; }' +
            '.tsv-card-badge__ep { font-weight: 600; }' +
            '.tsv-torrent-badge { display: inline-block; margin: 0.4em 0 0.2em; padding: 0.15em 0.6em; border-radius: 0.3em; background: #3b9a4b; color: #fff; font-size: 0.95em; }';

        $('<style id="tsv-style"></style>').text(css).appendTo('head');
    }

    function start() {
        addLang();
        addSettings();
        addStyle();

        Lampa.Listener.follow('torrent_file', onTorrentFile);
        Lampa.Listener.follow('torrent', onTorrent);

        myCardsObserve();

        if (Lampa.Timeline && Lampa.Timeline.listener) Lampa.Timeline.listener.follow('update', onTimeline);

        if (Lampa.Player && Lampa.Player.listener) {
            Lampa.Player.listener.follow('start', onPlayerStart);
            Lampa.Player.listener.follow('external', onPlayerStart);
        }
    }

    if (window.appready) start();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type == 'ready') start();
        });
    }
})();
