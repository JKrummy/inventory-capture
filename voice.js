/* JK Personal Inventory System - talk to fill.

   Jeff speaks one sentence about an item and this turns it into fields he can
   check before anything is saved.

   Two deliberate choices:

   1. The listening and the parsing both happen on the phone. The Anthropic key
      lives on the Mac and must never reach a web page, so there is no AI call
      here. These are plain rules, and because they are plain rules they are
      also predictable - the same sentence always fills the same boxes.

   2. Nothing is guessed into a field. If a sentence does not clearly say the
      make, the make stays empty, exactly as the AI pass on the Mac is told to
      behave. The raw words ride along with the item, so the Mac can do a better
      job of it later with the photos in front of it.

   The browser's own dictation is the fallback and the backstop: the box is a
   normal textarea, so the microphone key on the iPhone keyboard works even on
   a day when speech recognition will not start.  */

(function () {
  'use strict';

  /* ---------------------------------------------------------- numbers */

  const NUMWORD = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
    seventy: 70, eighty: 80, ninety: 90
  };

  const SCALE = { hundred: 100, thousand: 1000, grand: 1000, k: 1000, million: 1000000 };

  /* A number followed by one of these is measuring something else, not money.
     "twenty two hundred three years ago" is $2,200 and then a separate thought
     about when - without this it reads as $2,203. */
  const NOT_MONEY = new Set(['years', 'year', 'months', 'month', 'weeks', 'week',
    'days', 'day', 'rounds', 'round', 'boxes', 'box', 'inches', 'inch', 'feet',
    'foot', 'pounds', 'lbs', 'ounces', 'grams', 'grain', 'grains', 'ago',
    'miles', 'hours', 'o\'clock', 'percent', 'gauge', 'caliber', 'calibre']);

  /* Words that may sit between "paid" and the number without meaning anything.
     Each one that is a hedge also marks the number as a guess. */
  const FILLER = new Set(['me', 'it', 'for', 'a', 'an', 'of', 'is', 'was', 'i',
    'think', 'say', 'just', 'uh', 'um', 'oh', 'the', 'that', 'them']);
  const HEDGE = new Set(['about', 'around', 'roughly', 'approximately', 'maybe',
    'like', 'somewhere', 'near', 'close', 'nearly', 'probably', 'guessing',
    'ish', 'or', 'so', 'give', 'take', 'perhaps', 'figure']);

  /* Split into words, but remember where a clause ends. A comma inside 1,800 is
     a thousands separator; a comma at the end of a word ends the thought. */
  function tokenize(text) {
    return text.split(/\s+/).filter(Boolean).map((raw) => {
      const ends = /[,;.!?]$/.test(raw);
      const word = raw.replace(/[,;.!?]+$/, '');
      return { raw: word, word: word.toLowerCase(), ends: ends };
    });
  }

  /* Read an amount starting at tokens[i], skipping a few filler words first.
     Handles 1,800 - $1800 - 1.8k - eighteen hundred - two thousand five hundred. */
  function readAmount(tokens, i) {
    let n = i;
    let hedged = false;
    let skipped = 0;

    while (n < tokens.length && skipped < 4) {
      const w = tokens[n].word.replace(/[$]/g, '');
      if (HEDGE.has(w)) { hedged = true; n += 1; skipped += 1; continue; }
      if (FILLER.has(w)) { n += 1; skipped += 1; continue; }
      break;
    }

    let total = 0;
    let current = 0;
    let seen = false;
    let last = n - 1;

    while (n < tokens.length) {
      const token = tokens[n];
      const w = token.word.replace(/[$,]/g, '');

      const stuck = /^(\d+(?:\.\d+)?)(k|m)$/.exec(w);
      if (stuck) {
        total += parseFloat(stuck[1]) * (stuck[2] === 'k' ? 1000 : 1000000);
        seen = true;
        last = n;
        break;
      }

      const next = tokens[n + 1] ? tokens[n + 1].word.replace(/[,.]/g, '') : '';

      if (/^\d+(\.\d+)?$/.test(w)) {
        if (seen && current) break;           // "1800 2021" is two numbers
        if (NOT_MONEY.has(next)) { if (seen) break; return null; }
        current += parseFloat(w);
        seen = true;
      } else if (Object.prototype.hasOwnProperty.call(NUMWORD, w)) {
        if (NOT_MONEY.has(next)) { if (seen) break; return null; }
        current += NUMWORD[w];
        seen = true;
      } else if (Object.prototype.hasOwnProperty.call(SCALE, w)) {
        if (!seen && w !== 'hundred' && w !== 'thousand') break;
        const scale = SCALE[w];
        if (scale >= 1000) { total += (current || 1) * scale; current = 0; }
        else { current = (current || 1) * scale; }
        seen = true;
      } else if (w === 'and' && seen) {
        /* "two thousand and fifty" - keep going, but only once */
      } else if (w === 'bucks' || w === 'dollars') {
        last = n;
        break;
      } else {
        break;
      }

      last = n;
      n += 1;
      if (token.ends) break;                  // the clause stopped here
    }

    if (!seen) return null;
    return { value: total + current, hedged: hedged, end: last };
  }

  /* Find a trigger phrase, then read the amount that follows it. */
  function amountAfter(text, pattern) {
    const re = new RegExp(pattern, 'i');
    const m = re.exec(text);
    if (!m) return null;

    const rest = text.slice(m.index + m[0].length);
    const got = readAmount(tokenize(rest), 0);
    if (!got || !isFinite(got.value) || got.value <= 0) return null;

    /* "paid about" - the hedge may sit before the trigger too: "I think I paid" */
    const before = text.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const hedged = got.hedged || /\b(about|around|roughly|maybe|i think|probably|guess)\b/.test(before);

    return { value: got.value, hedged: hedged };
  }

  function dollars(n) {
    return n.toLocaleString('en-US', {
      minimumFractionDigits: n % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  /* ---------------------------------------------------------- phrases */

  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];

  /* Words that end a captured phrase. Without these, "from Cabela's in 2021"
     would make the store "Cabela's in 2021". */
  const STOP = new Set(['and', 'but', 'paid', 'pay', 'bought', 'buy', 'cost',
    'worth', 'value', 'sell', 'selling', 'belongs', 'owned', 'serial', 'model',
    'make', 'brand', 'condition', 'quantity', 'in', 'on', 'at', 'for', 'from',
    'it', 'its', "it's", 'i', 'about', 'around', 'back', 'with', 'there',
    'mounted', 'attached', 'stored', 'kept', 'sitting', 'year', 'years',
    'month', 'months', 'new', 'used', 'this', 'that']);

  /* Take up to `max` words of the original text after a match, stopping at a
     clause end or a word that starts a new thought. */
  function phraseAfter(original, matchEnd, max) {
    const tokens = tokenize(original.slice(matchEnd));
    const out = [];
    for (const t of tokens) {
      if (!t.word) continue;
      if (out.length && STOP.has(t.word)) break;
      if (/^\d{4}$/.test(t.word) && out.length) break;
      out.push(t.raw);
      if (t.ends || out.length >= max) break;
    }
    return out.join(' ').trim();
  }

  function titleish(s) {
    /* Dictation gives "cabela's" as often as "Cabela's". Capitalise the first
       letter of each word and leave the rest of the spelling alone. The letter
       after an apostrophe is not a new word, or Cabela's becomes Cabela'S. */
    return s.replace(/(^|[\s\-/])([a-z])/g, (m, lead, c) => lead + c.toUpperCase());
  }

  const CATEGORY_WORDS = [
    /* Optics come first on purpose: "Vortex scope on my AR" is a scope, not a
       rifle. And "gun" on its own is not a firearm - "gun safe" is where he
       keeps them and "gun accessories" is a different category entirely. */
    [/\b(scope|optic|red dot|reflex|holographic|sight|magnifier|bipod|sling|holster|suppressor|silencer|muzzle brake)\b/, 'Optics and gun accessories'],
    [/\b(rifle|shotgun|pistol|revolver|handgun|firearm|ar-?15|ak-?47|carbine)\b/, 'Firearms'],
    [/\b(ammo|ammunition|rounds|cartridges|shells|brass|primers)\b/, 'Ammunition'],
    [/\b(ring|necklace|bracelet|earrings|watch|rolex|diamond|gold chain)\b/, 'Jewelry and watches'],
    [/\b(truck|car|trailer|atv|utv|four wheeler|motorcycle|boat|tractor)\b/, 'Vehicles and trailers'],
    [/\b(laptop|computer|macbook|ipad|tablet|tv|television|camera|drone|phone|monitor|printer|speaker)\b/, 'Electronics'],
    [/\b(drill|saw|wrench|compressor|generator|welder|grinder|toolbox|mower|lathe)\b/, 'Tools and equipment'],
    [/\b(couch|sofa|chair|table|desk|dresser|bed|cabinet|bookcase)\b/, 'Furniture']
  ];

  const CONDITIONS = ['brand new', 'like new', 'mint', 'excellent', 'very good',
    'good', 'fair', 'poor', 'rough', 'beat up', 'well used'];

  /* ---------------------------------------------------------- the parser */

  /* Returns a list of findings, each one a field, a value, a plain sentence
     saying what it heard, and whether it sounded like a guess. The caller
     shows these for confirmation; nothing here touches the form. */
  function parse(spoken) {
    const original = String(spoken || '').trim().replace(/\s+/g, ' ');
    const text = original.toLowerCase();
    if (!original) return [];

    const found = [];
    const add = (field, value, heard, estimated) => {
      if (value === null || value === undefined || value === '') return;
      if (found.some((f) => f.field === field)) return;     // first win
      found.push({
        field: field,
        value: String(value),
        heard: heard,
        estimated: !!estimated,
        use: true
      });
    };

    /* --- money ------------------------------------------------------- */

    const paid = amountAfter(text, '\\b(?:i\\s+)?(?:paid|pay|cost|spent)\\b') ||
                 amountAfter(text, '\\b(?:bought|got|picked)\\s+(?:it|them|one)?\\s*(?:up)?\\s*for\\b') ||
                 amountAfter(text, '\\bprice\\s+(?:was|paid)?\\b') ||
                 /* "bought it from Cabela's for twenty two hundred" - the shop
                    sits between the verb and the number, so allow a short gap. */
                 amountAfter(text, '\\b(?:bought|got|picked|grabbed|paid)\\b[^,;.]{0,40}?\\bfor\\b');
    if (paid) {
      add('purchase_price', paid.value,
          'You paid $' + dollars(paid.value) + (paid.hedged ? ', give or take' : ''),
          paid.hedged);
    }

    const worth = amountAfter(text, "\\b(?:worth|value(?:d)?\\s+at|i'?d?\\s+(?:sell|get)(?:\\s+it)?\\s+for|sell\\s+it\\s+for|asking)\\b");
    if (worth) {
      add('my_value', worth.value,
          'You reckon it is worth $' + dollars(worth.value) + ' today',
          true);     /* a gut number is always a guess, hedged or not */
    }

    /* --- when he bought it -------------------------------------------- */

    let whenNote = null;
    let when = null;

    /* Find the year it was made first. "made in 1952" is not a purchase date,
       and without this an old rifle looks like it was bought in 1952. */
    const madeIn = /\b(?:made|built|manufactured)\s+(?:in\s+)?((?:19|20)\d{2})\b/.exec(text);
    if (madeIn) add('year_made', madeIn[1], 'Made in ' + madeIn[1], false);
    const dateText = madeIn
      ? text.slice(0, madeIn.index) + ' '.repeat(madeIn[0].length) + text.slice(madeIn.index + madeIn[0].length)
      : text;

    const full = /\b(\d{4}-\d{2}-\d{2})\b/.exec(dateText);
    const monthYear = new RegExp('\\b(' + MONTHS.join('|') + ')\\w*\\.?\\s+(?:of\\s+)?((?:19|20)\\d{2})\\b').exec(dateText);
    const slashed = /\b(\d{1,2})\/(\d{1,2})\/((?:19|20)?\d{2})\b/.exec(dateText);
    const yearOnly = /\b(?:in|back in|from|during|bought in|around)\s+((?:19|20)\d{2})\b/.exec(dateText) ||
                     /\b((?:19|20)\d{2})\b/.exec(dateText);
    const agoWords = /\b(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)|a\s+few|a\s+couple(?:\s+of)?)\s+years?\s+ago\b/.exec(dateText);
    const lastYear = /\blast\s+year\b/.test(text);
    const thisYear = /\b(?:this\s+year|earlier\s+this\s+year)\b/.test(text);

    if (full) {
      when = full[1];
      whenNote = 'Bought on ' + when;
    } else if (monthYear) {
      const mm = String(MONTHS.indexOf(monthYear[1]) + 1).padStart(2, '0');
      when = monthYear[2] + '-' + mm;
      whenNote = 'Bought in ' + titleish(monthYear[1]) + ' ' + monthYear[2];
    } else if (slashed) {
      const yr = slashed[3].length === 2 ? '20' + slashed[3] : slashed[3];
      when = yr + '-' + slashed[1].padStart(2, '0') + '-' + slashed[2].padStart(2, '0');
      whenNote = 'Bought on ' + when;
    } else if (yearOnly) {
      when = yearOnly[1];
      whenNote = 'Bought in ' + when;
    } else if (agoWords) {
      const word = agoWords[1];
      const years = word
        ? (/^\d+$/.test(word) ? parseInt(word, 10) : (NUMWORD[word] || 0))
        : (/couple/.test(agoWords[0]) ? 2 : 3);
      if (years > 0) {
        when = String(new Date().getFullYear() - years);
        whenNote = 'Bought about ' + years + ' years ago, so around ' + when;
      }
    } else if (lastYear) {
      when = String(new Date().getFullYear() - 1);
      whenNote = 'Bought last year, ' + when;
    } else if (thisYear) {
      when = String(new Date().getFullYear());
      whenNote = 'Bought this year, ' + when;
    }

    if (when) {
      /* Only the words just before the date make it a guess. "paid about 1,800
         in 2021" is a guess at the price and a plain fact about the year. */
      const at = (full || monthYear || slashed || yearOnly || agoWords);
      const lead = at ? dateText.slice(Math.max(0, at.index - 20), at.index) : '';
      const guessed = !!agoWords || (!full && /\b(about|around|roughly|maybe|sometime|think)\b\s*$|\b(about|around|roughly|maybe|sometime)\s+\w*$/.test(lead));
      add('purchase_date', when, whenNote, guessed);
    }

    /* --- where he bought it -------------------------------------------
       "from Cabela's" is a shop. "from the warehouse" is not - a shop is
       almost never spoken with "the" in front of it, and "the" is how he
       talks about his own places. */

    const sellerRe = /\b(?:bought\s+(?:it\s+)?(?:from|at)|from|at)\s+(?!the\b|my\b|his\b|her\b|our\b|work\b|home\b|house\b)/i;
    const sellerMatch = sellerRe.exec(original);
    if (sellerMatch) {
      const phrase = phraseAfter(original, sellerMatch.index + sellerMatch[0].length, 3);
      if (phrase && !/^\d+$/.test(phrase)) {
        add('seller', titleish(phrase), 'Bought from ' + titleish(phrase), false);
      }
    }

    /* --- where it is, and what it is mounted on ---------------------
       These two are both prepositions and they fight over the same words, so
       they are settled in one pass, in the order he said them:

         "on my AR"        a thing of his, so it is an attachment
         "on the wall"     a place, so it is a location
         "in the gun safe" a place

       Doing it in one pass is what stops "it's in the gun safe" being eaten by
       the earlier "on my AR" and vanishing. */

    const invMatch = /\b(?:mounted\s+on|attached\s+to|sitting\s+on|on)\s+(inv-?\s?\d{1,5})\b/i.exec(original);
    if (invMatch) {
      const digits = invMatch[1].replace(/\s/g, '').replace(/^inv-?/i, '');
      const id = 'INV-' + digits.padStart(5, '0');
      add('attached_to', id, 'Mounted on ' + id, false);
    }

    const prepRe = /\b(mounted\s+on|attached\s+to|sitting\s+on|goes\s+on|in|inside|at|on)\s+(the|my)\s+/gi;
    let prep;
    while ((prep = prepRe.exec(original)) !== null) {
      const word = prep[1].toLowerCase().replace(/\s+/g, ' ');
      const article = prep[2].toLowerCase();
      const phrase = phraseAfter(original, prep.index + prep[0].length, 4);
      if (!phrase) continue;

      const isAttachment = word !== 'in' && word !== 'inside' && word !== 'at' &&
                           (word !== 'on' || article === 'my');

      if (isAttachment) {
        /* No item number was spoken, so this cannot go in the attached-to box.
           That box holds an INV number, and a wrong one points at the wrong
           item. The words go in the notes, where they are still findable. */
        if (!invMatch) {
          add('notes', 'Mounted on ' + article + ' ' + phrase,
              'Mounted on ' + article + ' ' + phrase +
              ' - noted, but you will need to pick the item number later', false);
        }
      } else {
        add('location', titleish(phrase), 'It lives in the ' + phrase.toLowerCase(), false);
      }
    }

    /* --- whose it is ---------------------------------------------------- */

    if (/\b(?:belongs\s+to\s+me|it'?s\s+mine|mine\b|my\s+own)\b/.test(text)) {
      add('owner', 'Me', 'It is yours', false);
    } else {
      /* "belongs to my mother" names an owner. "it's out in the shop" does
         not, so a bare "it's" only counts when what follows is possessive. */
      const ownerRe = /\b(?:belongs\s+to|owned\s+by)\s+(?!mine\b|in\b|on\b|at\b|a\b|an\b|the\b)/i;
      const possessive = /\bit'?s\s+((?:my\s+)?[a-z]+'s)(?=\s|,|$)/i.exec(original);
      const ownerMatch = ownerRe.exec(original);
      if (ownerMatch) {
        const who = phraseAfter(original, ownerMatch.index + ownerMatch[0].length, 3).replace(/'s$/i, '');
        if (who && CONDITIONS.indexOf(who.toLowerCase()) === -1) {
          add('owner', titleish(who), 'It belongs to ' + titleish(who), false);
        }
      } else if (possessive) {
        const who = possessive[1].replace(/'s$/i, '');
        add('owner', titleish(who), 'It belongs to ' + titleish(who), false);
      }
    }

    /* --- the plain facts ------------------------------------------------ */

    const makeMatch = /\b(?:make|brand)\s+(?:is\s+)?/i.exec(original);
    if (makeMatch) {
      const v = phraseAfter(original, makeMatch.index + makeMatch[0].length, 2);
      if (v) add('make', titleish(v), 'Make: ' + titleish(v), false);
    }

    const modelMatch = /\bmodel\s+(?:number\s+|is\s+)?/i.exec(original);
    if (modelMatch) {
      const v = phraseAfter(original, modelMatch.index + modelMatch[0].length, 3);
      if (v) add('model', v, 'Model: ' + v, false);
    }

    const serialMatch = /\bserial\s*(?:number|no\.?|#)?\s*(?:is\s+)?([a-z0-9][a-z0-9 \-]{2,24})/i.exec(original);
    if (serialMatch) {
      const serial = serialMatch[1].replace(/\s+/g, '').toUpperCase().replace(/[-]+$/, '');
      if (serial.length >= 3) {
        add('serial', serial,
            'Serial number ' + serial + ' - check this one against the photo before you save it',
            true);
      }
    }

    const qty = /\b(?:quantity|there\s+are|i\s+have|i'?ve\s+got)\s+(\d+|two|three|four|five|six|seven|eight|nine|ten|twelve)\b/i.exec(text) ||
                /\b(\d+|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+of\s+(?:them|these|those)\b/i.exec(text);
    if (qty) {
      const raw = qty[1].toLowerCase();
      const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NUMWORD[raw];
      if (n && n > 1) add('quantity', n, 'There are ' + n + ' of them', false);
    }

    for (const word of CONDITIONS) {
      const re = new RegExp('\\b(?:in\\s+)?' + word + '\\s+(?:condition|shape)\\b|\\bcondition\\s+(?:is\\s+)?' + word + '\\b');
      if (re.test(text)) {
        add('condition', titleish(word), 'Condition: ' + word, false);
        break;
      }
    }

    for (const [re, name] of CATEGORY_WORDS) {
      if (re.test(text)) { add('category', name, 'Filed under ' + name, false); break; }
    }

    /* --- what it is -----------------------------------------------------
       The opening words, before he starts talking about money, people or
       places. Spoken descriptions nearly always lead with the thing itself. */

    const cutAt = [];
    const cutters = [
      /\b(?:i\s+)?(?:paid|pay|cost|spent|bought|got\s+it|picked\s+(?:it|up))\b/,
      /\bfor\s+\$?\d/,
      /\b(?:worth|value|belongs|owned\s+by|serial|quantity)\b/,
      /\b(?:it'?s|its)\s+(?:in|on|at)\b/,
      /\b(?:mounted|attached|stored|kept)\b/,
      /\bin\s+(?:19|20)\d{2}\b/,
      /\bfrom\s+[a-z]/,
      /\b(?:in|on|at)\s+(?:the|my)\b/,
      /\bin\s+(?:brand new|like new|mint|excellent|very good|good|fair|poor|rough)\b/
    ];
    for (const re of cutters) {
      const m = re.exec(text);
      if (m) cutAt.push(m.index);
    }
    const comma = original.indexOf(',');
    if (comma > 0) cutAt.push(comma);

    let head = cutAt.length ? original.slice(0, Math.min.apply(null, cutAt)) : original;
    head = head
      .replace(/^(?:hey|ok|okay|so|um|uh|right)[\s,]+/i, '')
      .replace(/^(?:this\s+is|it'?s|that'?s|here'?s|i\s+(?:have|just)|i'?ve\s+got)\s+/i, '')
      .replace(/^just\s+/i, '')
      .replace(/^(?:a|an|the|my)\s+/i, '')
      .replace(/[,.;:\s]+$/, '')
      .trim();
    if (!head) {
      /* "Hey I just picked up a Garmin watch for 1.8k" leaves nothing in front,
         so take what he says he bought instead. */
      const boughtRe = /\b(?:picked\s+up|bought|got|grabbed)\s+(?:a|an|the|my|myself\s+a)?\s*/i;
      const boughtMatch = boughtRe.exec(original);
      if (boughtMatch) {
        head = phraseAfter(original, boughtMatch.index + boughtMatch[0].length, 5);
      }
    }

    if (head.length < 3 || /^(?:uh|um|er|hmm|yeah|okay)$/i.test(head)) head = '';

    if (head && head.length <= 70 && /[a-z]/i.test(head)) {
      add('name', head, 'What it is: ' + head, false);
    }

    return found;
  }

  /* ---------------------------------------------------------- listening */

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  function createListener(handlers) {
    if (!Recognition) return null;

    let rec = null;
    let wanted = false;        // he tapped Start and has not tapped Stop
    let settled = '';          // everything recognised so far, final only

    function build() {
      const r = new Recognition();
      r.lang = 'en-US';
      r.continuous = true;
      r.interimResults = true;

      r.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const chunk = event.results[i][0].transcript;
          if (event.results[i].isFinal) settled += chunk;
          else interim += chunk;
        }
        handlers.onText((settled + interim).replace(/\s+/g, ' ').trim());
      };

      /* iOS stops listening on its own after a pause. If he has not tapped
         Stop, start it again - otherwise a thinking pause ends the recording
         mid-sentence and he has to notice and tap again. */
      r.onend = () => {
        if (wanted) {
          try { r.start(); } catch { handlers.onStop(); }
        } else {
          handlers.onStop();
        }
      };

      r.onerror = (event) => {
        wanted = false;
        const why = event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'The microphone is blocked. Allow it for this page in Settings, or type instead.'
          : event.error === 'no-speech'
            ? 'I did not hear anything. Tap the microphone and try again.'
            : 'Listening stopped: ' + event.error + '. You can type or dictate into the box instead.';
        handlers.onError(why);
      };

      return r;
    }

    return {
      supported: true,
      start(startFrom) {
        settled = startFrom ? startFrom.replace(/\s+$/, '') + ' ' : '';
        wanted = true;
        rec = build();
        try { rec.start(); } catch (err) { wanted = false; handlers.onError(String(err.message || err)); }
      },
      stop() {
        wanted = false;
        if (rec) { try { rec.stop(); } catch { /* already stopped */ } }
      },
      get listening() { return wanted; }
    };
  }

  window.JKVoice = {
    parse: parse,
    createListener: createListener,
    canListen: !!Recognition,
    dollars: dollars
  };
})();
