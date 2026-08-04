/**
 * Landing analytics — speed-first.
 *
 * Critical path (sync, no network): local visitor id + rewrite bot CTAs to
 * ?start=lp_<id> so attribution works even if PostHog never loads.
 *
 * PostHog (optional): only after window load + idle. Official snippet:
 * https://posthog.com/docs/libraries/js
 *
 * Docker build replaces __POSTHOG_*__ placeholders when token is set.
 */
;(function () {
  var token = '__POSTHOG_PROJECT_TOKEN__'
  var host = '__POSTHOG_HOST__'
  var botUsername = 'zap_gram_bot'
  var STORAGE_KEY = 'zg_vid'
  var phEnabled = token && token.indexOf('__POSTHOG') !== 0
  if (!host || host.indexOf('__POSTHOG') === 0) host = 'https://eu.i.posthog.com'

  // --- Critical path: local only, microseconds ---
  var visitorId = getOrCreateVisitorId()
  rewriteBotAnchors(visitorId)

  if (!phEnabled) return

  // --- Analytics: after first paint / load, never on critical path ---
  function schedulePostHog() {
    var run = function () {
      loadPostHog()
    }
    if ('requestIdleCallback' in window) {
      requestIdleCallback(run, {timeout: 4000})
    } else {
      setTimeout(run, 1)
    }
  }

  if (document.readyState === 'complete') {
    schedulePostHog()
  } else {
    window.addEventListener('load', schedulePostHog, {once: true})
  }

  function loadPostHog() {
    // Official PostHog JS snippet (verbatim from docs)
    !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[])

    posthog.init(token, {
      api_host: host,
      defaults: '2026-05-30',
      // Same id as deep-link payload so bot alias merges web + telegram person
      bootstrap: visitorId ? {distinctID: visitorId} : undefined,
      // Keep the landing light: no replay / flags round-trips (autocapture on for clicks)
      autocapture: true,
      disable_session_recording: true,
      capture_pageleave: false,
      advanced_disable_feature_flags: true,
      persistence: 'localStorage+cookie',
      loaded: function (ph) {
        ph.register({
          app: 'landing',
          locale: document.documentElement.lang || 'en',
        })
        // Capture is fire-and-forget; never blocks navigation
        document.addEventListener(
          'click',
          function (e) {
            var a = e.target && e.target.closest ? e.target.closest('a[href]') : null
            if (!a || !isBotCta(a)) return
            ph.capture('landing_cta_click', {
              cta_location: ctaLocation(a),
              bot_url: a.href,
              start_param: landingStartParam(visitorId),
            })
          },
          true,
        )
      },
    })
  }

  function getOrCreateVisitorId() {
    try {
      var id = localStorage.getItem(STORAGE_KEY)
      if (id && /^[A-Za-z0-9_-]{8,64}$/.test(id)) return id
      id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12)
      localStorage.setItem(STORAGE_KEY, id)
      return id
    } catch (_) {
      return null
    }
  }

  function landingStartParam(distinctId) {
    if (!distinctId) return 'landing'
    var safe = String(distinctId).replace(/[^A-Za-z0-9_-]/g, '')
    if (!safe) return 'landing'
    return ('lp_' + safe).slice(0, 64)
  }

  function botDeepLink(distinctId) {
    return 'https://t.me/' + botUsername + '?start=' + landingStartParam(distinctId)
  }

  function isBotCta(anchor) {
    if (!anchor || !anchor.href) return false
    try {
      var u = new URL(anchor.href, window.location.origin)
      if (u.hostname !== 't.me' && u.hostname !== 'telegram.me') return false
      if (u.pathname.replace(/^\//, '') !== botUsername) return false
      if (u.searchParams.has('startgroup')) return false
      return true
    } catch (_) {
      return false
    }
  }

  function ctaLocation(el) {
    if (el.closest('.site-header')) return 'header'
    if (el.closest('.hero')) return 'hero'
    if (el.closest('.mid-cta')) return 'mid'
    if (el.closest('.final')) return 'final'
    if (el.closest('.site-footer')) return 'footer'
    return 'other'
  }

  function rewriteBotAnchors(distinctId) {
    var url = botDeepLink(distinctId)
    var anchors = document.querySelectorAll('a[href]')
    for (var i = 0; i < anchors.length; i++) {
      if (!isBotCta(anchors[i])) continue
      anchors[i].setAttribute('href', url)
    }
  }
})()
