/* Copy pack: on-screen words from an event profile. Global: window.CopyPack
 *
 * No model and no network. Party promo copy is a formulaic genre — short, capital,
 * declarative, middle dots between facts — so an authored bank crossed with the
 * event details produces real variety without inventing anything.
 */
(function () {
  'use strict';

  var DAYS = {
    MON: 'MONDAY', TUE: 'TUESDAY', TUES: 'TUESDAY', WED: 'WEDNESDAY', THU: 'THURSDAY',
    THUR: 'THURSDAY', THURS: 'THURSDAY', FRI: 'FRIDAY', SAT: 'SATURDAY', SUN: 'SUNDAY'
  };

  var BANK = {
    // Looking back at a night that already happened.
    recapCaption: [
      'NO {EVENT}. NO PARTY.',
      'THAT WAS {EVENT}.',
      '{CITY} DID NOT COME TO PLAY.',
      'WE DON’T DO QUIET NIGHTS.',
      'THIS IS WHAT YOU MISSED.',
      'IF YOU KNOW, YOU KNOW.',
      'THE ONES WHO SHOWED UP.',
      '{EVENT} DOES NOT MISS.',
      'ASK ANYBODY WHO WAS THERE.',
      'STILL NOT OVER IT.',
      'ONE MORE FOR THE ARCHIVE.',
      'SHUT THE PLACE DOWN.',
      'TELL A FRIEND.',
      'THAT ROOM WAS SOMETHING ELSE.'
    ],
    // Looking forward to one that has not.
    announceHeadline: [
      '{EVENT} IS BACK',
      '{EVENT} RETURNS',
      'IT’S {EVENT} SEASON',
      'ONE NIGHT. {CITY}.',
      'CLEAR YOUR {DAY}',
      'WE’RE BACK AT {VENUE}',
      '{GENRE} NIGHT IS BACK',
      'THE WAIT IS OVER',
      'LOCK IN {DATE}',
      '{DATE}. BE THERE.',
      'BACK WHERE IT STARTED',
      'YOU KNOW WHAT TIME IT IS'
    ],
    announceSubline: [
      '{DATE} · {TICKETS}',
      '{DATE} · {VENUE}',
      '{VENUE} · {DOORS}',
      '{DATE} · {DOORS} · {TICKETS}'
    ],
    cta: [
      'TICKETS IN BIO',
      'LINK IN BIO',
      'GET YOUR TICKETS',
      'TAP THE LINK',
      'DON’T SLEEP ON THIS',
      'RSVP IN BIO',
      'SECURE THE TICKET',
      'LAST FEW TICKETS'
    ],
    eyebrow: [
      'FEATURING',
      'ON THE DECKS',
      'YOUR LINEUP',
      'WHO’S PLAYING',
      'LIVE FROM THE BOOTH',
      'THE ROSTER',
      'BRINGING THE HEAT'
    ]
  };

  function pick(list, n) {
    // n rotates the choice so "reroll" walks the bank instead of repeating.
    return list[((n % list.length) + list.length) % list.length];
  }

  function dayFrom(date) {
    var m = String(date || '').toUpperCase().match(/\b(MON|TUES?|WED|THU(?:RS?)?|FRI|SAT|SUN)\b/);
    return m ? (DAYS[m[1]] || 'NIGHT') : 'CALENDAR';
  }

  function joinDots(parts) {
    return parts.filter(function (p) { return p && String(p).trim(); })
                .map(function (p) { return String(p).trim(); })
                .join(' · ');
  }

  function fill(tpl, p) {
    var map = {
      EVENT: p.event || 'THE VILLAGE',
      DATE: p.date || '',
      VENUE: p.venue || '',
      CITY: p.city || 'PITTSBURGH',
      DOORS: p.doors || '',
      TICKETS: p.tickets || 'TICKETS IN BIO',
      GENRE: p.genre || 'THE',
      DAY: dayFrom(p.date)
    };
    var out = String(tpl).replace(/\{(\w+)\}/g, function (_, k) {
      return map[k] != null ? String(map[k]).toUpperCase() : '';
    });
    // A missing field can leave stray separators or doubled spaces behind.
    return out.replace(/\s*·\s*(?=·|$)/g, '').replace(/^\s*·\s*/, '')
              .replace(/\s{2,}/g, ' ').replace(/\s+\./g, '.').trim();
  }

  /* Values for one template, given the profile, the mode and a roll counter. */
  function forTemplate(id, p, mode, n) {
    var dateline = joinDots([p.date, p.venue, p.city]);
    var lineup = String(p.lineup || '').split('\n')
      .map(function (s) { return s.trim().toUpperCase(); })
      .filter(Boolean);

    if (id === 'promo') {
      return {
        title: (p.event || '').toUpperCase(),
        dateline: dateline.toUpperCase(),
        lineup: pairUp(lineup),
        cta: mode === 'recap' ? fill(pick(BANK.cta, n + 2), p) : fill(pick(BANK.cta, n), p)
      };
    }
    if (id === 'lineup') {
      return {
        eyebrow: fill(pick(BANK.eyebrow, n), p),
        names: lineup.join('\n'),
        footer: joinDots([p.date, p.doors]).toUpperCase()
      };
    }
    if (id === 'recap') {
      return { caption: fill(pick(BANK.recapCaption, n), p) };
    }
    if (id === 'announce') {
      return {
        headline: fill(pick(mode === 'recap' ? BANK.recapCaption : BANK.announceHeadline, n), p),
        subline: fill(pick(BANK.announceSubline, n), p)
      };
    }
    return {};
  }

  // The promo template gives the lineup five lines; two names a line reads better
  // than one long column.
  function pairUp(names) {
    var out = [];
    for (var i = 0; i < names.length; i += 2) {
      out.push(names.slice(i, i + 2).join(' · '));
    }
    return out.join('\n');
  }

  /* Which template each clip in the cut should wear.
   * Open with a statement, let the middle be footage with just a watermark, and
   * close on the details — that is how these edits are actually built. */
  function templateFor(index, count, mode) {
    if (count <= 1) return mode === 'recap' ? 'recap' : 'promo';
    if (index === 0) return 'announce';
    if (index === count - 1) return mode === 'recap' ? 'announce' : 'promo';
    if (mode === 'promo' && count > 3 && index === count - 2) return 'lineup';
    return 'recap';
  }

  function generate(profile, mode, roll) {
    var n = roll || 0;
    return {
      templateFor: function (i, c) { return templateFor(i, c, mode); },
      valsFor: function (id, i) { return forTemplate(id, profile, mode, n + i); }
    };
  }

  window.CopyPack = { generate: generate, forTemplate: forTemplate, templateFor: templateFor, BANK: BANK };
})();
