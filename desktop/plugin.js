import { host, useValue, gatewayActivationEpoch, useGatewayActivationEpoch, useQuery, useMutation, useQueryClient, Button, Input, Textarea, ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'
import { useState, useRef, useEffect, useLayoutEffect, createElement as h } from 'react'

// Review + explicit opt-in still-image generation. Generation is dispatched ONLY by a confirmed click
// (never by saving, mounting, tab changes or polling) through the backend, which owns provider access.
// No payment, external media URLs or credentials in the UI.
// Styling uses host theme tokens only and is scoped to .retake.
// Layout: projects rail | work area. The work area is a grid with a persistent media stage,
// a compact version filmstrip and one Review inspector that docks right (wide) or below (constrained).

const RAIL_OPEN = 216
const RAIL_SHUT = 60
const NARROW_ROOT = 900 // route width below which the projects rail auto-collapses
const BOTTOM_DOCK = 820 // work-area width below which the inspector docks under the stage
const THUMB_B64_LIMIT = 349600 // 256 KiB PNG, base64-encoded
const MEDIA_MIME = /^(image\/(png|jpeg|webp)|video\/mp4)$/
// Video upload is hidden until tested natively; the backend still accepts MP4 and stored videos still play.
const VIDEO_UPLOADS = globalThis.RETAKE_ENABLE_VIDEO_UPLOADS === true
const UPLOAD_MIMES = ['image/png', 'image/jpeg', 'image/webp', ...(VIDEO_UPLOADS ? ['video/mp4'] : [])]
const UPLOAD_ACCEPT = UPLOAD_MIMES.join(',')
const UPLOAD_KINDS = VIDEO_UPLOADS ? 'PNG, JPEG, WebP, MP4' : 'PNG, JPEG, WebP'

const cssBase = `
.retake{container:rt-root / inline-size;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;color:var(--ui-text-primary);font:inherit;font-size:13px;line-height:1.45;box-sizing:border-box}
.retake *{box-sizing:border-box}
.retake h1,.retake h2,.retake h3,.retake h4,.retake p,.retake ul,.retake ol,.retake dl,.retake dd,.retake figure{margin:0}
.retake h1{font-size:15px;font-weight:650;letter-spacing:-.01em;line-height:1.2}
.retake h2{font-size:14px;font-weight:600;line-height:1.3}
.retake h3{font-size:13px;font-weight:600;line-height:1.35}
.retake :is(h2,h3,p,li,dd){overflow-wrap:anywhere}
.retake button,.retake input,.retake textarea,.retake select{font:inherit}
.retake input:not([type=checkbox]):not([type=file]),.retake textarea,.retake select{color:var(--ui-text-primary);background:var(--ui-bg-editor);border:1px solid var(--ui-stroke-secondary);border-radius:6px;padding:5px 8px;min-width:0;max-width:100%}
.retake textarea{width:100%;min-height:56px;resize:vertical;line-height:1.5}
.retake :is(input,textarea,select):disabled{opacity:.6;cursor:not-allowed}
.retake :is(button,input,textarea,select,summary,[tabindex]):focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}
.retake button{cursor:pointer;white-space:normal}
.retake button:disabled{cursor:not-allowed;opacity:.5}
.retake label{display:flex;flex-direction:column;gap:4px;min-width:0;max-width:100%;font-size:12px;color:var(--ui-text-secondary)}
`

const cssUtility = `
.retake .rt-row{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap}
.retake .rt-row>*{min-width:0;max-width:100%}
.retake .rt-between{justify-content:space-between}
.retake .rt-muted{color:var(--ui-text-secondary);font-size:12px;line-height:1.5}
.retake .rt-eyebrow{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ui-text-secondary)}
.retake .rt-id{font-size:11px;font-variant-numeric:tabular-nums;color:var(--ui-text-quaternary,var(--ui-text-secondary));overflow-wrap:anywhere;user-select:all}
.retake .rt-trunc{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.retake .rt-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.retake .rt-pill{display:inline-flex;align-items:center;gap:5px;border:0;border-radius:0;padding:1px 4px;font-size:11px;line-height:1.6;color:var(--ui-text-secondary);white-space:nowrap}
.retake .rt-status{display:inline-flex;align-items:center;gap:4px;border:0;border-radius:0;padding:0 3px;font-size:11px;line-height:1.6;white-space:nowrap;color:var(--ui-text-primary);flex:none}
.retake .rt-status svg{flex:none}
.retake .rt-status[data-status=selected]{color:var(--ui-accent);background:transparent}
.retake .rt-status[data-status=rejected]{color:var(--ui-text-secondary)}
.retake .rt-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ui-text-secondary)}
.retake .rt-icon:hover:not(:disabled){background:var(--ui-bg-secondary);color:var(--ui-text-primary)}
.retake .rt-tabs{display:inline-flex;gap:2px;padding:2px;border:0;border-radius:0;background:transparent;flex:none}
.retake .rt-tabs [role=tab]{border:0;border-radius:0;padding:3px 12px;background:transparent;color:var(--ui-text-secondary);font-size:12px;font-weight:500;white-space:nowrap}
.retake .rt-tabs [role=tab]:hover:not(:disabled){color:var(--ui-text-primary)}
.retake .rt-tabs [role=tab][aria-selected=true]{background:transparent;color:var(--ui-text-primary);font-weight:600;box-shadow:inset 0 -2px 0 var(--ui-accent)}
.retake .rt-notice{display:flex;align-items:flex-start;gap:10px;margin:8px 14px 0;padding:6px 8px 6px 12px;border:1px solid var(--ui-stroke-secondary);border-left:3px solid var(--ui-stroke-secondary);border-radius:6px;background:var(--ui-bg-secondary);font-size:12px;flex:none}
.retake .rt-notice[data-kind=error]{border-left-color:var(--ui-accent)}
.retake .rt-notice>span{flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;align-self:center}
.retake .rt-notice strong{font-weight:600}
.retake .rt-x{flex:none;background:transparent;border:0;border-radius:4px;padding:2px 6px;color:var(--ui-text-secondary);font-size:15px;line-height:1}
.retake .rt-x:hover{color:var(--ui-text-primary)}
`

const cssShell = `
/* Header: product, project > asset breadcrumb, Review | Compare mode, scope pills. */
/* One type size (13px) across breadcrumb, asset picker and mode tabs; weight and colour carry hierarchy. */
.retake .rt-top{display:flex;align-items:center;flex-wrap:wrap;gap:6px 16px;padding:6px 14px;border-bottom:1px solid var(--ui-stroke-secondary);flex:none;min-height:44px}
.retake .rt-crumbs{display:flex;align-items:center;flex-wrap:wrap;gap:4px 6px;flex:1 1 300px;min-width:0}
.retake .rt-crumbs h1{font-size:13px;font-weight:600;color:var(--ui-text-secondary);letter-spacing:0}
.retake .rt-crumbs h2{font-size:13px;font-weight:600;max-width:min(28ch,100%)}
.retake .rt-crumbs select{flex:0 1 auto;width:auto;max-width:min(280px,100%);field-sizing:content;padding:3px 6px;border-color:transparent;background:transparent;font-size:13px;text-overflow:ellipsis}
.retake .rt-model{display:flex;flex-direction:column;gap:4px}
.retake .rt-model select{max-width:100%}
.retake .rt-asset{display:flex;flex-direction:row;align-items:center;gap:4px;min-width:0;font-size:12px;color:var(--ui-text-secondary)}
.retake .rt-asset-name{font-size:13px;max-width:min(280px,100%)}
.retake .rt-crumbs select:hover:not(:disabled){border-color:var(--ui-stroke-secondary);background:var(--ui-bg-editor)}
.retake .rt-sep{color:var(--ui-text-secondary);opacity:.7}
.retake .rt-crumbs .rt-icon{width:22px;height:22px;min-height:0;padding:0}
.retake .rt-crumb{padding:0 3px;line-height:1.5;min-height:0;border:0;border-radius:4px;background:transparent;color:var(--ui-text-secondary);font-size:13px;font-weight:600;cursor:pointer;max-width:min(28ch,100%);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.retake .rt-crumb:hover:not(:disabled){color:var(--ui-text-primary);text-decoration:underline}
.retake .rt-crumb[aria-current=page]{color:var(--ui-text-primary);cursor:default;text-decoration:none}
.retake .rt-menu-wrap{position:relative;display:inline-flex}
.retake .rt-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:20;min-width:180px;padding:4px;border:1px solid var(--ui-stroke-secondary);border-radius:6px;background:var(--ui-bg-editor);box-shadow:0 8px 24px rgba(0,0,0,.35)}
.retake .rt-menu [role=menuitem]{display:block;width:100%;padding:6px 8px;border:0;border-radius:4px;background:transparent;color:var(--ui-text-primary);font-size:12px;text-align:left;cursor:pointer}
.retake .rt-menu [role=menuitem]:hover,.retake .rt-menu [role=menuitem]:focus-visible{background:var(--ui-bg-secondary)}
.retake .rt-overview{overflow:auto}
.retake .rt-assets{list-style:none;margin:0;padding:12px 14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;align-content:start}
.retake .rt-asset-card{display:flex;flex-direction:column;gap:6px;width:100%;padding:6px 6px 8px;border:1px solid transparent;border-radius:6px;background:color-mix(in srgb,var(--ui-bg-secondary) 65%,transparent);color:var(--ui-text-primary);text-align:left;cursor:pointer}
.retake .rt-asset-card:hover:not(:disabled),.retake .rt-asset-card:focus-visible{border-color:var(--ui-accent)}
.retake .rt-assets .rt-asset-card .rt-thumb,.retake .rt-assets .rt-asset-card .rt-cover{width:100%;height:auto;aspect-ratio:4/3;font-size:20px}
.retake .rt-assets .rt-asset-card .rt-cover img{width:100%;height:100%;object-fit:contain}
.retake .rt-asset-card[data-attempt],.retake .rt-asset-card[data-editing]{cursor:default}
.retake .rt-asset-item{position:relative}
.retake .rt-rename-btn{position:absolute;top:10px;right:10px;width:26px;height:26px;opacity:0;background:var(--ui-bg-editor);border:1px solid var(--ui-stroke-secondary);border-radius:6px}
.retake .rt-asset-item:hover .rt-rename-btn,.retake .rt-rename-btn:focus-visible{opacity:1}
@media (hover:none){.retake .rt-rename-btn{opacity:1}}
.retake .rt-rename{width:100%;padding:3px 6px;font-size:13px;font-weight:600}
.retake .rt-new-card{height:100%;border:1px dashed var(--ui-stroke-secondary);background:transparent;color:var(--ui-text-secondary)}
.retake .rt-new-card:hover:not(:disabled),.retake .rt-new-card[aria-expanded=true]{border-color:var(--ui-accent);color:var(--ui-text-primary)}
.retake .rt-assets .rt-new-card .rt-new-plus{background:transparent;font-size:34px;font-weight:300;line-height:1;color:inherit}
.retake .rt-new-menu{top:auto;left:6px;right:6px;bottom:auto;margin-top:4px}
.retake .rt-menu .rt-menu-file{position:relative;display:block;padding:6px 8px;border-radius:4px;font-size:12px;cursor:pointer;color:var(--ui-text-primary)}
.retake .rt-menu .rt-menu-file:hover,.retake .rt-menu .rt-menu-file:focus-visible{background:var(--ui-bg-secondary)}
.retake .rt-menu .rt-menu-file input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.retake .rt-asset-text{display:flex;flex-direction:column;gap:3px;min-width:0;font-size:12px}
.retake .rt-asset-text strong{font-size:13px;font-weight:600}
.retake .rt-asset-meta{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;color:var(--ui-text-secondary)}
.retake{position:relative}
.retake .rt-overlay{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(8,8,12,.6)}
.retake .rt-dialog{display:flex;flex-direction:column;gap:10px;width:min(420px,100%);padding:18px 20px;border:1px solid var(--ui-stroke-secondary);border-radius:8px;background:var(--ui-bg-editor);box-shadow:0 16px 48px rgba(0,0,0,.5);font-size:13px}
.retake .rt-dialog h2{font-size:14px;font-weight:600}
.retake .rt-dialog p{color:var(--ui-text-secondary)}
.retake .rt-dialog .rt-row{justify-content:flex-end;gap:8px}
.retake .rt-dialog .rt-dialog-error{color:var(--ui-text-primary);padding:6px 8px;border-left:3px solid #e5484d;background:var(--ui-bg-secondary)}
.retake button.rt-danger{border-color:#c4363b;background:#c4363b;color:#fff}
.retake button.rt-danger:hover:not(:disabled){background:#d63e44}
.retake .rt-menu [role=menuitem]:disabled{color:var(--ui-text-secondary);opacity:.5;cursor:not-allowed;background:transparent}
.retake .rt-status-btn{display:inline-flex;align-items:center;gap:4px;flex:none;min-height:24px;padding:1px 6px;border:1px solid transparent;border-radius:999px;background:transparent;cursor:pointer}
.retake .rt-status-btn:hover:not(:disabled),.retake .rt-status-btn[aria-expanded=true]{border-color:var(--ui-stroke-secondary);background:var(--ui-bg-secondary)}
.retake .rt-status-btn .rt-caret{font-size:10px;color:var(--ui-text-secondary)}
.retake .rt-menu [role=menuitemradio]{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;border:0;border-radius:4px;background:transparent;color:var(--ui-text-primary);font-size:12px;text-align:left;cursor:pointer;white-space:nowrap}
.retake .rt-menu [role=menuitemradio]:hover,.retake .rt-menu [role=menuitemradio]:focus-visible{background:var(--ui-bg-secondary)}
.retake .rt-menu .rt-mcheck{width:12px;color:var(--ui-accent)}
.retake .rt-menu-why{display:block;max-width:220px;padding:0 8px 6px;font-size:11px;color:var(--ui-text-secondary)}
.retake .rt-top .rt-tabs [role=tab]{font-size:13px;padding:5px 10px}
.retake .rt-top-tools{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin-left:auto}
.retake .rt-top-tools .rt-icon{width:26px;height:26px;opacity:.85}
.retake .rt-top-tools .rt-icon:hover:not(:disabled){opacity:1}

/* Shell: rail + work area shrink to the route; compact tracks preserve the media anchor. */
.retake .rt-shell{flex:1 1 0;min-height:0;min-width:0;display:grid;grid-template-columns:var(--rt-rail,${RAIL_OPEN}px) minmax(0,1fr)}

/* Projects rail */
.retake .rt-rail{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0;padding:10px 8px;border-right:1px solid var(--ui-stroke-secondary);background:color-mix(in srgb,var(--ui-bg-secondary) 45%,transparent)}
.retake .rt-rail-head{display:flex;align-items:center;justify-content:space-between;gap:4px;padding-left:4px}
.retake .rt-rail[data-collapsed=true] .rt-rail-head{justify-content:center;padding-left:0}
.retake .rt-projects{list-style:none;padding:0;display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-height:0;overflow-y:auto}
.retake .rt-proj{display:grid;grid-template-columns:36px minmax(0,1fr);align-items:center;gap:9px;width:100%;padding:5px;border:0;border-radius:0;background:transparent;color:var(--ui-text-secondary);text-align:left}
.retake .rt-proj:hover:not(:disabled){background:var(--ui-bg-secondary);color:var(--ui-text-primary)}
.retake .rt-proj[aria-pressed=true]{background:var(--ui-bg-secondary);box-shadow:inset 2px 0 0 var(--ui-accent);color:var(--ui-text-primary);font-weight:600}
.retake .rt-proj-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;line-height:1.3}
.retake .rt-rail[data-collapsed=true] .rt-proj{grid-template-columns:36px;justify-content:center;padding:3px}
.retake .rt-rail[data-collapsed=true] .rt-proj-name{display:none}
.retake .rt-proj-item{position:relative}
.retake .rt-rail:not([data-collapsed=true]) .rt-proj{padding-right:32px}
.retake .rt-proj-item[data-editing=true] .rt-proj{padding-right:5px}
.retake .rt-proj-more{position:absolute;top:50%;right:4px;width:24px;height:24px;transform:translateY(-50%);opacity:0}
.retake .rt-proj-item:hover .rt-proj-more,.retake .rt-proj-item:focus-within .rt-proj-more,.retake .rt-proj-item[data-current=true] .rt-proj-more,.retake .rt-proj-more[aria-expanded=true]{opacity:1}
@media (hover:none){.retake .rt-proj-more{opacity:1}}
.retake .rt-cover{display:flex;align-items:center;justify-content:center;width:36px;height:36px;flex:none;overflow:hidden;border:1px solid var(--ui-stroke-secondary);border-radius:6px;background:var(--ui-bg-secondary);color:var(--ui-text-secondary);font-size:12px;font-weight:600;letter-spacing:.02em}
.retake .rt-cover img{display:block;width:100%;height:100%;object-fit:cover}
.retake .rt-new{display:flex;flex-direction:column;gap:6px;padding-top:10px;border-top:1px solid var(--ui-stroke-secondary)}
.retake .rt-new input{width:100%}
.retake .rt-new-btn{width:36px;height:36px;margin:0 auto;border-color:var(--ui-stroke-secondary)}

/* Work grid. data-dock is measured with ResizeObserver on the route container, not the window. */
.retake .rt-work{display:grid;min-width:0;min-height:0;grid-template-columns:minmax(0,1fr) 340px;grid-template-rows:minmax(0,1fr) auto;grid-template-areas:"main insp" "strip insp"}
.retake .rt-work[data-dock=bottom]{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(240px,3fr) auto minmax(200px,2fr);grid-template-areas:"main" "strip" "insp"}
.retake .rt-work[data-insp=none]{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(200px,1fr) auto;grid-template-areas:"main" "strip"}
`

const cssStage = `
.retake .rt-main{grid-area:main;display:flex;flex-direction:column;min-width:0;min-height:0}
.retake .rt-main-empty{align-items:center;justify-content:center;padding:20px;overflow:auto}
.retake .rt-bar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 14px;padding:8px 14px;border-bottom:1px solid var(--ui-stroke-secondary);flex:none}
.retake .rt-bar-title{display:flex;align-items:center;flex-wrap:wrap;gap:2px 8px;flex:1 1 220px;min-width:0}
.retake .rt-bar-title h3{max-width:100%}
.retake .rt-bar-v{flex:none;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.retake .rt-bar-meta{flex-basis:100%;font-size:11px}
.retake .rt-bar-title>.rt-dl{margin-left:4px}
.retake .rt-dl{display:inline-flex;align-items:center;gap:5px;flex:none;min-height:28px;padding:3px 10px;border:1px solid var(--ui-stroke-secondary);border-radius:6px;background:transparent;color:var(--ui-text-primary);font-size:12px;font-weight:500;line-height:1.4;white-space:nowrap}
.retake .rt-dl:hover:not(:disabled){border-color:var(--ui-text-secondary);background:var(--ui-bg-secondary)}
.retake .rt-dl-sm{min-height:22px;padding:1px 7px;font-size:11px}
/* Pixel size: the meta line carries it on roomy routes; compact routes hide that line, so show W×H here. */
.retake .rt-bar-dim{display:none;flex:none;font-size:11px;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums}
.retake[data-compact=true] .rt-bar-dim{display:inline}
/* Decision is one segmented control: three exclusive states, lighter than three free-standing buttons. */
/* The stage is a size container: media fit uses cq units so the annotation wrapper is exactly the rendered media box. */
.retake .rt-stage{flex:1 1 0;min-height:150px;container-type:size;display:flex;align-items:center;justify-content:center;padding:12px;overflow:hidden;background:color-mix(in srgb,var(--ui-bg-secondary) 70%,transparent)}
.retake .rt-media{position:relative;display:block;flex:none;line-height:0;touch-action:none;user-select:none}
.retake .rt-media[data-draw=true]{cursor:crosshair}
.retake .rt-media img,.retake .rt-media video{display:block;width:auto;height:auto;max-width:100cqw;max-height:100cqh}
.retake .rt-region{position:absolute;border:2px solid var(--ui-accent);border-radius:2px;background:color-mix(in srgb,var(--ui-accent) 15%,transparent);pointer-events:none}
.retake .rt-region[data-saved=true]{border-style:dashed}
.retake .rt-mark{position:absolute;z-index:1;border:1px solid color-mix(in srgb,var(--ui-accent) 70%,transparent);border-radius:2px;pointer-events:none}
.retake .rt-mark[data-active=true]{border-width:2px;border-color:var(--ui-accent)}
.retake .rt-mark-n,.retake .rt-note-n{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--ui-accent);color:var(--ui-bg-editor);font-size:10px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.retake .rt-mark-n{position:absolute;left:-1px;top:-1px;transform:translate(-35%,-35%);opacity:.92}
.retake .rt-mark[data-active=true] .rt-mark-n{opacity:1;box-shadow:0 0 0 2px var(--ui-bg-editor)}
/* One empty/loading/error grammar: a title line, one muted sentence, optional actions. */
.retake .rt-wait{display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px;max-width:100%;text-align:center;color:var(--ui-text-secondary);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.retake .rt-wait[data-kind=error]{color:var(--ui-text-primary)}
.retake .rt-spin{display:block;width:16px;height:16px;flex:none;border:2px solid var(--ui-stroke-secondary);border-top-color:var(--ui-accent);border-radius:50%;animation:rt-spin .8s linear infinite}
@keyframes rt-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.retake .rt-spin{animation:none}}
.retake .rt-empty{display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;max-width:440px;padding:22px 24px;border:1px dashed var(--ui-stroke-secondary);border-radius:8px;text-align:center;color:var(--ui-text-secondary);font-size:12px;line-height:1.5}
.retake .rt-empty-title{color:var(--ui-text-primary);font-size:13px;font-weight:600}
.retake .rt-empty>.rt-row{justify-content:center;margin-top:4px}
.retake .rt-empty[data-kind=loading]{border-color:transparent}
.retake .rt-empty[data-kind=error]{align-items:flex-start;text-align:left;border-style:solid;border-left:3px solid var(--ui-accent);background:var(--ui-bg-secondary)}
.retake .rt-empty[data-kind=error]>.rt-row{justify-content:flex-start}
.retake .rt-start{display:flex;flex-direction:column;align-items:center;gap:18px;width:100%;max-width:480px;text-align:center}
.retake .rt-start h3{margin:0;font-size:17px;font-weight:600;color:var(--ui-text-primary)}
.retake .rt-start-sub{margin:-10px 0 0;color:var(--ui-text-secondary);font-size:12.5px}
.retake .rt-choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),220px));gap:12px;width:100%;justify-content:center}
.retake .rt-choice{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:150px;margin:0;padding:12px;border:1px dashed var(--ui-stroke-secondary);border-radius:10px;background:transparent;color:var(--ui-text-primary);font:inherit;font-size:13px;text-align:center;cursor:pointer}
.retake .rt-choice:hover:not(:disabled){border-color:var(--ui-accent)}
.retake .rt-choice:disabled,.retake .rt-choice[data-disabled=true]{opacity:.55;cursor:not-allowed}
.retake .rt-choice-drop{border-color:var(--ui-accent);background:color-mix(in srgb,var(--ui-accent) 7%,transparent)}
.retake .rt-choice-drop[data-over=true]{border-style:solid;background:color-mix(in srgb,var(--ui-accent) 18%,transparent)}
.retake .rt-choice-drop input{position:absolute;left:0;top:0;width:1px;height:1px;margin:0;padding:0;opacity:0;overflow:hidden;clip-path:inset(50%)}
.retake .rt-choice-ic{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--ui-bg-secondary);font-size:18px}
.retake .rt-choice b{font-weight:600}
.retake .rt-choice small{color:var(--ui-text-secondary);font-size:11.5px}
.retake .rt-flow{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px 10px;margin:0;padding:0;list-style:none;color:var(--ui-text-secondary);font-size:12px;counter-reset:rt-step}
.retake .rt-flow li{display:flex;align-items:center;gap:6px;counter-increment:rt-step}
.retake .rt-flow li::before{content:counter(rt-step);display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--ui-bg-secondary);color:var(--ui-text-primary);font-size:10.5px}
.retake .rt-flow li:not(:last-child)::after{content:'→';margin-left:4px;opacity:.5}

/* Compare mode: two explicit versions, independent media controls, no winner semantics. */
.retake .rt-cmp{flex:1 1 0;min-height:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:12px}
.retake .rt-work[data-dock=bottom] .rt-cmp{grid-template-columns:minmax(0,1fr);grid-template-rows:repeat(2,minmax(0,1fr))}
.retake .rt-fig{display:flex;flex-direction:column;gap:6px;min-width:0;min-height:0;padding:8px;border:0;border-radius:0;background:color-mix(in srgb,var(--ui-bg-secondary) 45%,transparent)}
.retake .rt-fig-frame{flex:1 1 0;min-height:110px;container-type:size;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:0;background:transparent}
.retake .rt-fit{flex:none;line-height:0}
.retake .rt-fit img,.retake .rt-fit video{display:block;width:auto;height:auto;max-width:100cqw;max-height:100cqh}
.retake .rt-fig figcaption{display:flex;flex-direction:column;gap:2px;min-width:0;padding-top:6px;border-top:1px solid var(--ui-stroke-secondary);font-size:12px}
.retake .rt-fig figcaption .rt-row{flex-wrap:nowrap}
.retake .rt-fig-v{flex:none;font-size:13px}
.retake .rt-fig-name{flex:1 1 auto;color:var(--ui-text-secondary)}
.retake .rt-fig figcaption>.rt-trunc{font-size:11px}
.retake .rt-fig-id{font-size:10px}
.retake .rt-badge{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:20px;height:20px;padding:0 4px;border-radius:5px;background:color-mix(in srgb,var(--ui-accent) 24%,transparent);color:var(--ui-text-primary);font-size:11px;font-weight:700}
.retake .rt-fig-rel{font-size:11px}
.retake .rt-slot{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:110px;padding:16px;border:1px dashed var(--ui-stroke-secondary);border-radius:8px;color:var(--ui-text-secondary);font-size:12px;text-align:center}
.retake .rt-slot .rt-badge{width:24px;height:24px;font-size:12px}
`

const cssStrip = `
/* Filmstrip: versions of the current asset only; scrolls horizontally inside its own box. */
.retake .rt-strip{grid-area:strip;display:flex;flex-wrap:wrap;align-items:stretch;gap:10px 14px;min-width:0;padding:8px 14px 10px;border-top:1px solid var(--ui-stroke-secondary)}
.retake .rt-strip-main{display:flex;flex-direction:column;gap:6px;flex:999 1 280px;min-width:0}
.retake .rt-strip-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 12px}
.retake .rt-film{list-style:none;display:flex;gap:8px;min-width:0;padding:2px 2px 6px;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;scrollbar-width:thin}
/* Tile: thumbnail, then "v2 + status" (primary), then the stored filename (secondary), then an A/B chip. */
.retake .rt-frame{position:relative;display:flex;flex-direction:column;gap:5px;flex:none;width:148px;padding:4px 4px 6px;border:0;border-radius:0;background:color-mix(in srgb,var(--ui-bg-secondary) 65%,transparent)}
.retake .rt-frame[data-active=true]{background:color-mix(in srgb,var(--ui-accent) 8%,var(--ui-bg-secondary));box-shadow:inset 0 -2px 0 var(--ui-accent)}
.retake .rt-frame-btn{display:flex;flex-direction:column;gap:5px;width:100%;min-width:0;padding:0;border:0;border-radius:5px;background:transparent;color:inherit;text-align:left}
.retake .rt-frame-text{display:flex;flex-direction:column;gap:1px;min-width:0;padding:0 2px}
.retake .rt-frame-head{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap}
.retake .rt-frame-head .rt-status{min-width:0;overflow:hidden;text-overflow:ellipsis;padding:0}
.retake .rt-frame-v{flex:none;font-size:12px;font-weight:700;color:var(--ui-text-primary);font-variant-numeric:tabular-nums}
.retake .rt-frame-file{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--ui-text-secondary)}
.retake .rt-frame[data-attempt] .rt-thumb{border:1px dashed var(--ui-stroke-secondary);background:transparent}
.retake .rt-frame[data-attempt] .rt-astate{font-size:11px;font-weight:600}
.retake .rt-strip-title{display:flex;align-items:baseline;gap:6px;font-size:12px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--ui-text-primary)}
.retake .rt-sec-title{font-size:12px;font-weight:600;color:var(--ui-text-primary);margin:4px 0 0}
.retake .rt-insp-title{font-size:13px;font-weight:600;margin:0 4px}
.retake .rt-row.rt-end{justify-content:flex-end;gap:8px}
.retake .rt-strip-actions{display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:6px;margin-left:auto}
.retake .rt-strip-actions>*{min-height:24px;padding:1px 10px;font-size:12px}
.retake .rt-strip-actions .rt-gen-next{display:inline-flex;align-items:center;gap:6px}
.retake .rt-earlier summary{font-size:12px;color:var(--ui-text-secondary);cursor:pointer}
.retake .rt-earlier-open{padding:6px 0 4px 8px}
.retake .rt-strip-count{font-variant-numeric:tabular-nums;font-weight:500;color:var(--ui-text-secondary)}
.retake .rt-frame[data-status=rejected] .rt-thumb>img{opacity:.45}
.retake .rt-thumb{display:flex;align-items:center;justify-content:center;gap:4px;width:100%;aspect-ratio:16/10;overflow:hidden;border-radius:5px;background:var(--ui-bg-secondary);color:var(--ui-text-secondary);font-size:10px;line-height:1.2;text-align:center}
.retake .rt-thumb img{display:block;max-width:100%;max-height:100%;object-fit:contain}
/* A/B compare chip: a real checkbox; the chosen slot letter is the visible state. */
.retake label.rt-check{flex-direction:row;align-items:center;align-self:flex-start;gap:4px;height:18px;margin-left:2px;padding:0 6px 0 4px;border:1px solid var(--ui-stroke-secondary);border-radius:999px;font-size:10px;line-height:1;color:var(--ui-text-secondary);cursor:pointer;white-space:nowrap}
.retake label.rt-check{position:relative}
.retake label.rt-check::after{content:'';position:absolute;inset:-4px}
.retake label.rt-check input{position:relative;z-index:1}
.retake label.rt-check:hover{color:var(--ui-text-primary);border-color:var(--ui-text-secondary)}
.retake label.rt-check b{font-size:11px;font-weight:700;color:var(--ui-text-primary)}
.retake label.rt-check input{margin:0;width:12px;height:12px;accent-color:var(--ui-accent)}
.retake label.rt-check:has(input:checked){border-color:var(--ui-accent);background:color-mix(in srgb,var(--ui-accent) 18%,transparent);color:var(--ui-text-primary)}
.retake label.rt-check:has(input:disabled){opacity:.5;cursor:not-allowed}
.retake label.rt-upload{position:relative;flex-direction:row;align-items:center;justify-content:center;gap:6px;padding:5px 12px;border:1px solid var(--ui-accent);border-radius:6px;background:color-mix(in srgb,var(--ui-accent) 12%,transparent);color:var(--ui-text-primary);font-size:12px;font-weight:600;white-space:nowrap;cursor:pointer}
.retake label.rt-upload:hover{background:color-mix(in srgb,var(--ui-accent) 20%,transparent)}
.retake label.rt-upload:has(input:focus-visible){outline:2px solid var(--ui-accent);outline-offset:2px}
.retake label.rt-upload[data-disabled=true]{opacity:.55;cursor:progress}
.retake label.rt-upload input{position:absolute;left:0;top:0;width:1px;height:1px;margin:0;padding:0;opacity:0;overflow:hidden;clip-path:inset(50%)}
`

// Generation: sections inside the existing inspector zone, separated by dividers (no cards, no modal).
const cssGenerate = `
.retake .rt-gen{display:flex;flex-direction:column;gap:10px;min-width:0;padding:12px 0;border-top:1px solid var(--ui-stroke-secondary)}
.retake .rt-gen-prompt textarea{min-height:104px}
.retake label.rt-aspect select{align-self:flex-start;min-width:160px}
.retake .rt-gen-ref{display:grid;grid-template-columns:72px minmax(0,1fr);gap:4px 10px;align-items:start}
.retake .rt-gen-ref .rt-thumb{height:48px;aspect-ratio:auto}
.retake .rt-gen dl.rt-brief-quote{display:flex;flex-direction:column;gap:6px}
.retake .rt-gen dd{white-space:pre-wrap;line-height:1.45}
.retake .rt-facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;padding:8px 10px;border-radius:6px;background:var(--ui-bg-secondary);font-size:12px;line-height:1.4}
.retake .rt-facts dt{color:var(--ui-text-secondary)}
.retake .rt-how{display:flex;flex-direction:column;gap:8px}
.retake .rt-charge{font-weight:600}
.retake .rt-confirm{display:flex;flex-direction:column;gap:6px;padding:2px 0 2px 10px;box-shadow:inset 2px 0 0 var(--ui-accent)}
.retake .rt-why{padding:4px 0 4px 10px;box-shadow:inset 2px 0 0 var(--ui-stroke-secondary);color:var(--ui-text-secondary);font-size:12px}
.retake .rt-attempts{list-style:none;padding:0;display:flex;flex-direction:column}
.retake .rt-attempt{display:flex;flex-direction:column;gap:2px;padding:7px 0;border-bottom:1px solid var(--ui-stroke-secondary);font-size:12px}
.retake .rt-astate{font-weight:600}
.retake .rt-attempt[data-state=running] .rt-astate,.retake .rt-frame[data-attempt] .rt-astate{color:var(--ui-accent)}
.retake .rt-insp-title{font-size:13px;font-weight:600}
`

const cssInspector = `
/* One Review inspector. Only its body scrolls; the stage never moves. */
.retake .rt-insp{grid-area:insp;display:flex;flex-direction:column;min-width:0;min-height:0;border-left:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-editor)}
.retake .rt-work[data-dock=bottom] .rt-insp{border-left:0;border-top:1px solid var(--ui-stroke-secondary)}
.retake .rt-insp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;min-height:44px;padding:6px 8px 6px 12px;border-bottom:1px solid var(--ui-stroke-secondary)}
.retake .rt-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px 8px}
.retake .rt-insp-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:10px 12px 12px}
.retake .rt-insp-body>fieldset{display:flex;flex-direction:column;gap:12px;min-width:0;margin:0;padding:0;border:0}
.retake .rt-compose{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 0;border:0;border-top:1px solid var(--ui-stroke-secondary);border-radius:0;background:transparent}
.retake .rt-insp-body>fieldset>.rt-compose:first-child{border-top:0;padding-top:0}
.retake .rt-compose-sticky{position:sticky;bottom:0;z-index:1;background:var(--ui-bg-editor);box-shadow:none}
.retake .rt-inspect{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;padding:6px 8px;border:1px dashed var(--ui-accent);border-radius:6px;font-size:12px}
.retake .rt-inspect>span{flex:1 1 160px;min-width:0}
.retake .rt-details{font-size:12px;color:var(--ui-text-secondary);min-width:0}
.retake .rt-details summary{width:fit-content;max-width:100%;cursor:pointer;border-radius:4px;overflow-wrap:anywhere}
.retake .rt-details summary:hover{color:var(--ui-text-primary)}
.retake .rt-details[open] summary{margin-bottom:6px}
.retake .rt-numbers{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.retake .rt-numbers input{width:100%}
.retake .rt-identity dl{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:6px;background:var(--ui-bg-secondary)}
.retake .rt-identity-row{display:grid;grid-template-columns:60px minmax(0,1fr);gap:8px;align-items:baseline}
.retake .rt-identity dt{font-size:11px}
.retake .rt-identity p{margin-top:6px}
.retake .rt-notes{list-style:none;padding:0;display:flex;flex-direction:column;gap:2px}
.retake .rt-note{display:flex;align-items:flex-start;gap:8px;width:100%;min-width:0;padding:6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left}
.retake button.rt-note{cursor:pointer}
.retake button.rt-note:hover,.retake .rt-notes li[data-active=true] .rt-note{background:var(--ui-bg-secondary)}
.retake .rt-notes li[data-active=true] .rt-note{box-shadow:inset 2px 0 0 var(--ui-accent)}
.retake .rt-note-kind{flex:none;display:flex;align-items:center;gap:2px;min-height:18px;font-size:11px;font-variant-numeric:tabular-nums;color:var(--ui-text-secondary)}
.retake .rt-notes li[data-active=true] .rt-note-kind{color:var(--ui-accent);font-weight:600}
.retake .rt-note-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
.retake .rt-compose-foot{display:flex;align-items:flex-start;gap:8px}
.retake .rt-compose-foot>.rt-details{flex:1 1 auto;padding-top:5px}
.retake .rt-compose-foot>.rt-row{flex:none;margin-left:auto;flex-wrap:nowrap}
.retake .rt-draw-hint{margin:0;padding-bottom:10px}
.retake .rt-drafts{list-style:none;padding:0;display:flex;flex-direction:column;gap:2px}
.retake .rt-draft{display:flex;align-items:baseline;justify-content:space-between;gap:10px;width:100%;padding:6px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ui-text-primary);text-align:left}
.retake .rt-draft:hover{background:var(--ui-bg-secondary)}
.retake .rt-draft[aria-pressed=true]{background:var(--ui-bg-secondary);border-color:var(--ui-stroke-secondary)}
.retake .rt-brief{display:flex;flex-direction:column;gap:10px;padding:12px 0;border:0;border-top:1px solid var(--ui-stroke-secondary);border-radius:0;background:transparent}
.retake .rt-brief dl{display:flex;flex-direction:column;gap:10px}
.retake .rt-brief dd{margin-top:2px;line-height:1.5;white-space:pre-wrap}
`

// Short routes need a bounded strip/drawer budget, not another scrolling page.
// The media flexes into the remaining space; only the inspector and filmstrip scroll.
const cssCompact = `
.retake[data-compact=true] .rt-top{padding:4px 8px;gap:2px 10px;min-height:0}
.retake[data-compact=true] .rt-crumbs{flex:1 1 300px;gap:2px 6px}
.retake[data-compact=true] .rt-crumbs h2{max-width:14ch}
.retake[data-compact=true] .rt-crumbs select{flex:0 1 auto;max-width:min(220px,100%)}
.retake[data-compact=true] .rt-top .rt-tabs [role=tab]{padding:4px 10px}
.retake[data-compact=true] .rt-top-tools .rt-pill~.rt-pill{display:none}
.retake[data-compact=true] .rt-notice{margin:4px 8px 0;padding:3px 6px;font-size:11px}
.retake[data-compact=true] .rt-bar{padding:5px 8px;gap:4px}
.retake[data-compact=true] .rt-bar-title{flex:1 1 120px;flex-wrap:nowrap}
.retake[data-compact=true] .rt-bar-title>.rt-dl{min-height:24px;padding:1px 8px}
.retake[data-compact=true] .rt-bar-meta{display:none}
.retake[data-compact=true] .rt-stage{min-height:0;padding:6px}
.retake[data-compact=true] .rt-work{grid-template-rows:minmax(0,1fr) 116px}
.retake[data-compact=true] .rt-work[data-dock=bottom]{grid-template-rows:minmax(0,1fr) 116px minmax(110px,min(180px,30%))}
.retake[data-compact=true] .rt-work[data-insp=none]{grid-template-rows:minmax(0,1fr) 116px;grid-template-areas:"main" "strip"}
.retake[data-compact=true] .rt-work[data-dock=bottom] .rt-cmp{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:minmax(0,1fr);gap:6px;padding:6px}
.retake[data-compact=true] .rt-fig{overflow:hidden;padding:5px}
.retake[data-compact=true] .rt-fig-frame{min-height:0}
.retake[data-compact=true] .rt-fig figcaption{flex:0 0 auto;max-height:64px;overflow:auto;overscroll-behavior:contain;gap:1px;line-height:1.35}
.retake[data-compact=true] .rt-fig figcaption .rt-row{gap:4px}
.retake[data-compact=true] .rt-fig figcaption .rt-status{font-size:10px;padding:0}
.retake[data-compact=true] .rt-fig-id{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.retake[data-compact=true] .rt-strip{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);gap:2px 6px;height:116px;min-height:0;padding:3px 6px 4px}
.retake[data-compact=true] .rt-strip-main{display:contents}
.retake[data-compact=true] .rt-strip-head{grid-column:1;grid-row:1;display:flex;align-items:baseline;line-height:14px}
.retake[data-compact=true] .rt-strip-title{font-size:11px;line-height:14px}
.retake[data-compact=true] .rt-strip-head>:not(h3):not(.rt-strip-actions),.retake[data-compact=true] .rt-strip-of{display:none}

.retake[data-compact=true] .rt-strip-dot{display:none}

.retake[data-compact=true] .rt-strip-main>:not(.rt-strip-head){grid-column:1;grid-row:2;min-height:0}
.retake[data-compact=true] .rt-film{padding:1px 1px 3px;min-height:0}
/* Compact tile: thumb left; v + status, filename and the A/B chip stacked right. */
.retake[data-compact=true] .rt-frame{display:block;width:200px;padding:3px 6px 3px 3px}
.retake[data-compact=true] .rt-frame-btn{display:grid;grid-template-columns:64px minmax(0,1fr);align-items:center;gap:7px}
.retake[data-compact=true] .rt-frame-text{gap:0;padding:0 0 19px}
.retake[data-compact=true] .rt-frame .rt-status{font-size:10px}
.retake[data-compact=true] .rt-frame-file{font-size:10px}
.retake[data-compact=true] .rt-frame label.rt-check{position:absolute;left:74px;bottom:4px;height:16px;margin:0}
.retake[data-compact=true] .rt-frame[data-attempt] .rt-frame-text{padding-bottom:0}
.retake[data-compact=true] .rt-thumb{height:40px;aspect-ratio:auto}
.retake[data-compact=true] .rt-strip-actions{flex-wrap:nowrap}
.retake[data-compact=true] .rt-strip-actions>*{min-height:22px;padding:0 8px;font-size:11px}
.retake[data-compact=true] .rt-insp-head{min-height:0;padding:4px 6px}
/* Native title/status chrome can leave less than 480px for the route. Keep
   the media usable without hiding the filmstrip, actions or authored drafts. */
.retake[data-tight=true] .rt-work[data-dock=bottom][data-insp=open]{grid-template-rows:minmax(0,1fr) 116px 76px}
.retake[data-tight=true] .rt-bar{padding:3px 6px}
.retake[data-tight=true] .rt-bar-title{flex:0 0 auto}
.retake[data-tight=true] .rt-bar-title>:not(.rt-dl):not(.rt-menu-wrap){display:none}
.retake[data-tight=true] .rt-notice[data-kind=ok]>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@container rt-root (max-width:600px){
 .retake .rt-crumbs{width:100%;flex-wrap:nowrap}
 .retake .rt-crumbs>*{flex:none}
 .retake .rt-crumbs h2{flex:0 1 auto;min-width:3ch;max-width:14ch}
 .retake .rt-crumbs h2 .rt-crumb{max-width:100%}
 .retake .rt-crumbs .rt-asset,.retake .rt-crumbs .rt-asset-name{flex:1 1 0;min-width:4ch}
 .retake .rt-crumbs select{max-width:100%;min-width:0;width:100%}
 .retake .rt-asset>span{display:none}
 .retake .rt-assets{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}
 .retake[data-compact=true] .rt-bar-dim{display:none}
}
`
const css = [cssBase, cssUtility, cssShell, cssStage, cssStrip, cssInspector, cssGenerate, cssCompact].join('\n')

const text = e => e instanceof Error ? e.message : String(e)
const enc = encodeURIComponent
const el = (tag, props, ...children) => children.length ? h(tag, props, ...children.flat()) : h(tag, props)
const btn = (label, onClick, props = {}) => el(Button, { type: 'button', variant: 'outline', size: 'sm', onClick, ...props }, label)
const field = (label, value, onChange, props = {}) => el('label', {}, label, h(Input, { value, onChange: e => onChange(e.target.value), ...props }))
const area = (label, value, onChange, className, placeholder) => el('label', { className }, label, h(Textarea, { 'aria-label': label, value, placeholder, onChange: e => onChange(e.target.value) }))

// Presentation helpers. Status always carries a text label; icon and color are secondary cues.
// Stored values are unchanged; 'selected' is shown as Approved and is the asset's one pick.
const STATUS = { selected: 'Approved', needs_revision: 'Needs changes', rejected: 'Rejected' }
// The asset's approved take (the last one, should older data hold several), or null.
const pickOf = asset => [...asset.items].reverse().find(v => v.status === 'selected') || null
const ICON = {
  edit: 'M2 10l.6-2.4L8.2 2 10 3.8 4.4 9.4zM7.2 3l1.8 1.8',
  selected: 'M2.5 6.3 5 8.7l4.5-5.2', needs_revision: 'M9.9 4.3A4 4 0 1 0 10 6.2M10 1.8v2.6H7.4', rejected: 'M3.3 3.3l5.4 5.4M8.7 3.3 3.3 8.7',
  upload: 'M6 8.5V2M3.5 4.4 6 2l2.5 2.4M2 10.2h8', download: 'M6 2v6.5M3.5 6.1 6 8.5l2.5-2.4M2 10.2h8', left: 'M7.5 2.5 4 6l3.5 3.5', right: 'M4.5 2.5 8 6l-3.5 3.5',
  down: 'M2.5 4.5 6 8l3.5-3.5', up: 'M2.5 7.5 6 4l3.5 3.5', plus: 'M6 2v8M2 6h8', video: 'M1.5 3.5h6v5h-6zM7.5 5.5l3-1.5v4l-3-1.5',
  spark: 'M6 1.5v3M6 7.5v3M1.5 6h3M7.5 6h3', x: 'M3 3l6 6M9 3 3 9', refresh: 'M10 6a4 4 0 1 1-1.2-2.85M10 1.8v2.6H7.4'
}
const icon = d => h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' }, h('path', { d }))
const status = s => el('span', { className: 'rt-status', 'data-status': s }, ICON[s] && icon(ICON[s]), STATUS[s] || String(s))
const shortId = id => { const s = String(id); return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s }
const size = n => !Number.isFinite(n) ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
const kind = mime => mime === 'video/mp4' ? 'MP4' : String(mime || '').split('/')[1]?.toUpperCase() || ''
const facts = v => [kind(v.mime), size(v.size), v.width && v.height ? `${v.width}×${v.height}` : '', v.duration != null ? `${Number(v.duration).toFixed(1)}s` : ''].filter(Boolean).join(' · ')
const when = t => { if (!t) return ''; const d = new Date(t); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
const lineage = (v, versions) => { if (!v.parent_id) return 'Original'; const p = versions.find(x => x.id === v.parent_id); return p ? `Revision of ${p.name}` : 'Revision' }
const initials = name => String(name || '').trim().split(/\s+/).slice(0, 2).map(w => [...w][0] || '').join('').toUpperCase() || '?'
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
// Generated or hash-like stored filenames identify nothing to a person: the asset ordinal stands in for them
// on screen. The stored name is unchanged and still used for downloads, details and tooltips.
const hashName = name => /^(generated|image|output|retake)?[-_]?[0-9a-f]{8,}(\.[a-z0-9]{2,4})?$/i.test(String(name || ''))
// Files travel as the documented JSON `body` of ctx.rest (base64); hosts refuse the multipart `upload`
// option on OAuth-gated remotes before sending. FileReader encodes off the JS stack (no argument spread).
const UPLOAD_TIMEOUT_MS = 180000
const fileBase64 = file => new Promise((resolve, reject) => {
  const r = new FileReader()
  r.onerror = () => reject(new Error('Could not read the file.'))
  r.onload = () => { const s = String(r.result || ''), i = s.indexOf(','); i > 0 ? resolve(s.slice(i + 1)) : reject(new Error('Could not read the file.')) }
  r.readAsDataURL(file)
})

// ---- Generation presentation. Attempt states are NOT review statuses and never enter STATUS. ----
// Direct route: a confirmed POST reserves an attempt, then POST .../run asks this profile's Retake backend
// to claim it once and call Hermes's configured `image_generate` through stock's tool server. No chat,
// session, focus or command catalog is involved. Retake chooses no provider or model.
const COST_UNKNOWN = 'Cost unknown'
const SCOPE_NOTE = 'Uses Hermes configured image generation; provider account may be charged; cost unknown.'
const COMMAND = 'retake-generate'
const RUN_WAIT_MS = 11 * 60 * 1000 // backend tool timeout is 10 min; after that the record reads unknown/stale
const ASPECTS = [['landscape', 'Landscape'], ['square', 'Square'], ['portrait', 'Portrait']]
const ATTEMPT = { reserved: 'Reserved · not sent yet', running: 'Generating in Hermes…', succeeded: 'Stored as a version', failed: 'Failed · no version', unknown: 'Outcome unknown' }
const ACTIVE_ATTEMPT = s => s === 'running' || s === 'reserved'
// Stable per-request nonce (32 lowercase hex): the same confirmed intent never reserves twice.
const requestId = () => (crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')).replace(/-/g, '').toLowerCase()
const aspectOf = v => !v?.width || !v?.height ? 'landscape' : v.width > v.height * 1.1 ? 'landscape' : v.height > v.width * 1.1 ? 'portrait' : 'square'
// Only the sanitized stock-route descriptor is accepted; anything else reads as unavailable.
function capabilities(q) {
  const d = q.data
  const s = v => typeof v === 'string' ? v.slice(0, 300) : ''
  const base = { available: false, label: 'Hermes configured image generation', cost: COST_UNKNOWN, note: SCOPE_NOTE, retryNote: '', revision: false, revisionReason: '', reason: '' }
  if (q.error) return { ...base, reason: `Generation status unavailable: ${text(q.error)}` }
  if (!d || typeof d !== 'object' || d.route !== 'direct') return { ...base, checking: !!q.isPending, reason: q.isPending ? 'Checking Retake…' : 'This Retake backend does not offer direct generation. Update the Retake plugin.' }
  return { ...base, available: d.available === true, reason: s(d.reason), note: s(d.note) || SCOPE_NOTE, retryNote: s(d.retry_note),
    revision: d.revision?.enabled === true, revisionReason: s(d.revision?.reason) || 'Automatic revision is not available.' }
}
const aspectField = (value, onChange) => el('label', { className: 'rt-aspect' }, 'Aspect', el('select', { value, onChange: e => onChange(e.target.value) }, ...ASPECTS.map(([id, label]) => el('option', { key: id, value: id }, label))))
const genFacts = (gen, extra = []) => el('dl', { className: 'rt-facts' }, ...[['Uses', 'Hermes configured image generation (image_generate)'],
  ['Provider/model', 'Whatever Hermes is configured to use; the tool’s own report is recorded after'],
  ['Cost', gen.cost || COST_UNKNOWN], ...extra].map(([k, v]) => [el('dt', { key: `${k}-t` }, k), el('dd', { key: `${k}-d` }, v)]))
const routeNote = route => route.ready ? null : el('p', { className: 'rt-why', role: 'status' }, route.reason)
const retryNote = gen => gen.retryNote || 'Retake never retries; the configured tool may still do its own retries or fallback.'
// Progressive disclosure: the one-line cost summary stays visible; the full mechanics sit behind a toggle.
const genSummary = (gen, runsIn, extra, ...more) => [
  el('p', { key: 'sum', className: 'rt-muted' }, ...(runsIn ? ['Runs in ', el('span', { key: 'r' }, runsIn)] : ['Hermes configured image generation']), ` · ${(gen.cost || COST_UNKNOWN).toLowerCase()}`),
  el('details', { key: 'how', className: 'rt-details' }, el('summary', {}, 'How generation runs'),
    el('div', { className: 'rt-how' }, genFacts(gen, extra), ...more))]
// Shown at the confirm decision point: the charge disclosure is never collapsed.
const confirmText = (gen, lead) => [el('p', { key: 'lead' }, lead), el('p', { key: 'charge', className: 'rt-charge' }, gen.note || SCOPE_NOTE), el('p', { key: 'retry', className: 'rt-muted' }, retryNote(gen))]

function AttemptList({ label, attempts, versions, onOpen, onCompare, onCheck, onSend, onCancel, canSend }) {
  if (!attempts.length) return null
  return el('div', { className: 'rt-gen' },
    el('h4', { className: 'rt-eyebrow' }, `${label} · ${attempts.length}`),
    el('ol', { className: 'rt-attempts', 'aria-label': label }, ...attempts.slice(0, 8).map(a => {
      const made = a.version_id ? versions.find(v => v.id === a.version_id) : null
      const open = ACTIVE_ATTEMPT(a.state) || a.state === 'unknown'
      const reserved = a.state === 'reserved'
      const reportedBy = [a.reported_provider, a.model].filter(Boolean).join(' · ')
      return el('li', { key: a.id, className: 'rt-attempt', 'data-state': a.state },
        el('div', { className: 'rt-row rt-between' }, el('span', { className: 'rt-astate' }, ATTEMPT[a.state] || 'Unrecognized state'), el('span', { className: 'rt-id', title: a.id, 'aria-label': `Attempt ${a.id}` }, `Attempt ${shortId(a.id)}`)),
        el('span', { className: 'rt-muted' }, [when(a.created_at), a.aspect_ratio, reportedBy ? `tool reported ${reportedBy} (variant not verified)` : a.model ? `model ${a.model}` : '', a.modality ? `${a.modality} input` : ''].filter(Boolean).join(' · ')),
        a.image_selection?.display ? el('span', { className: 'rt-muted' }, `Requested ${String(a.image_selection.display)} · ${BILLING[a.image_selection.billing] || 'subscription'}`) : null,
        a.selection_mismatch ? el('span', { className: 'rt-why' }, 'Hermes reported a different model or a fallback; not the model you chose.') : null,
        a.error?.message ? el('span', {}, String(a.error.message)) : null,
        open && a.outcome ? el('span', { className: 'rt-muted' }, String(a.outcome)) : null,
        made || open ? el('div', { className: 'rt-row' },
          made ? btn('Open version', () => onOpen(made.id), { 'aria-label': `Open version from attempt ${a.id}` }) : null,
          made && a.parent_id ? btn('Compare with parent', () => onCompare(a.parent_id, made.id), { 'aria-label': `Compare attempt ${a.id} result with its parent` }) : null,
          reserved && onSend ? btn('Run', () => onSend(a.id), { disabled: !canSend, 'aria-label': `Run reserved attempt ${a.id}`, title: 'Runs this one reserved attempt. Retake refuses if it already ran.' }) : null,
          reserved && onCancel ? btn('Cancel reservation', () => onCancel(a.id), { 'aria-label': `Cancel reserved attempt ${a.id}`, title: 'Releases a reservation Hermes has not run. Nothing was sent.' }) : null,
          open ? btn('Check status', onCheck, { 'aria-label': `Check status of attempt ${a.id}`, title: 'Re-reads Retake’s record. Does not contact Hermes, the tool or the provider and never retries.' }) : null) : null)
    })))
}

// Optional per-request model, from Hermes's own listing for this profile. Absent (older Hermes) => no picker
// at all and the configured-model flow is unchanged. A listed model is not proof the account may run it.
const BILLING = { 'subscription:chatgpt': 'ChatGPT subscription', 'subscription:nous': 'Nous subscription' }
const pickable = (picks, revision) => (picks.supported ? picks.list : []).filter(d => !revision || d.revision)
const chosenOf = (picks, revision, id) => pickable(picks, revision).find(d => d.id === id && d.available !== false) || null
function ModelField({ picks, revision, value, onChange }) {
  if (!picks.supported) return null
  const list = pickable(picks, revision)
  const d = chosenOf(picks, revision, value)
  const group = billing => list.filter(x => x.billing === billing)
  return el('div', { className: 'rt-model' },
    el('label', {}, 'Image model', el('select', { 'aria-label': 'Image model', value: d ? d.id : '', onChange: e => onChange(e.target.value) },
      el('option', { value: '' }, 'Hermes configured default'),
      ...Object.keys(BILLING).filter(b => group(b).length).map(b => el('optgroup', { key: b, label: BILLING[b] },
        ...group(b).map(x => el('option', { key: x.id, value: x.id, disabled: x.available === false, title: x.unavailable_reason || '' }, x.available === false ? `${x.display} · unavailable` : x.display)))))),
    d ? el('p', { className: 'rt-muted' }, [BILLING[d.billing], 'entitlement and cost unknown', d.available === null ? 'availability checked when it runs' : '', d.variant_enforced ? '' : 'quality is a hint, not guaranteed'].filter(Boolean).join(' · '))
      : revision && list.length < picks.list.length ? el('p', { className: 'rt-muted' }, 'Only models that can edit a reference image are listed.') : null)
}

// New-asset generation. Rendered in the inspector zone; the stage stays visible beside or above it.
function NewAssetPanel({ gen, route, prompt, setPrompt, aspect, setAspect, picks, model, setModel, onGenerate, onClose, generating, blocked, attempts, versions, onOpen, onCheck, onSend, onCancel }) {
  const [confirming, setConfirming] = useState(false)
  const edit = setter => v => { setter(v); setConfirming(false) }
  const chosen = chosenOf(picks, false, model)
  // Confirmation is bound to reviewed intent, the chosen model and the session it will run in.
  const reviewKey = JSON.stringify([aspect, prompt.trim(), route.key || '', chosen?.id || ''])
  useEffect(() => { setConfirming(false) }, [reviewKey, gen.available, route.ready])
  const ready = gen.available && route.ready
  return el('section', { key: 'gen-new', className: 'rt-insp', role: 'region', 'aria-label': 'Generate new asset' },
    el('div', { className: 'rt-insp-head' }, el('h3', { className: 'rt-insp-title' }, 'Generate new asset'),
      el('button', { type: 'button', className: 'rt-icon', 'aria-label': 'Close generation panel', title: 'Close · your prompt is kept', onClick: onClose }, icon(ICON.x))),
    el('div', { className: 'rt-insp-body' },
      el('fieldset', { disabled: !!generating, 'aria-label': 'New asset generation' },
        gen.available ? routeNote(route) : el('p', { className: 'rt-why', role: 'status' }, gen.reason || 'Image generation is not available for this profile.'),
        area('Prompt', prompt, edit(setPrompt), 'rt-gen-prompt'),
        aspectField(aspect, edit(setAspect)),
        h(ModelField, { picks, revision: false, value: model, onChange: edit(setModel) }),
        ...genSummary(gen, route.label, [['Creates', 'A new asset · first version']],
          el('p', { className: 'rt-muted' }, 'Configured in Hermes (Capabilities → Tools → Image Generation). Retake never changes it.')),
        blocked && !generating ? el('p', { className: 'rt-why', role: 'status' }, 'Another generation is reserved or running.') : null,
        confirming === reviewKey && ready
          ? el('div', { className: 'rt-confirm', role: 'group', 'aria-label': 'Confirm generation' },
            ...confirmText(gen, `Reserves this prompt${chosen ? ` for ${chosen.display}` : ''}, then runs it once.`),
            el('div', { className: 'rt-row' },
              btn(generating ? 'Generating…' : 'Generate with Hermes', () => onGenerate({ kind: 'new_asset', prompt: prompt.trim(), aspect, selection: chosen?.id || '' }), { variant: undefined, disabled: !ready || blocked || !prompt.trim() || !!generating }),
              btn('Back', () => setConfirming(false))))
          : el('div', { className: 'rt-row rt-between' }, el('span', { className: 'rt-muted' }, 'Nothing is reserved or sent until you confirm.'),
            btn('Review generation…', () => setConfirming(reviewKey), { variant: undefined, disabled: !ready || blocked || !prompt.trim() }))),
      h(AttemptList, { label: 'New-asset attempts', attempts, versions, onOpen, onCompare: () => {}, onCheck, onSend, onCancel, canSend: ready && !generating })))
}

// Revision from an explicitly SAVED brief bound to this exact version. Unsaved text is never used.
// Stock image_generate offers plugins no verified image-EDIT contract, so this stays disabled (with the
// reason shown) until the backend reports revision as qualified; saved briefs and manual upload remain.
// Confirm step for ONE saved request on this exact version. Nothing is reserved until "Generate revision with Hermes".
function ReviseSection({ scope, gen, route, version, briefs, openedId, onBack, generating, blocked, onGenerate, picks, attempts, versions, onOpen, onCompare, onCheck, onSend, onCancel }) {
  const [aspect, setAspect] = useState(aspectOf(version))
  const [model, setModel] = useState('')
  const b = briefs.find(x => x.id === openedId)
  const box = useRef(null)
  useEffect(() => { if (b) box.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }) }, [b?.id])
  const sel = chosenOf(picks, true, model) // style-only, text-only and unavailable models are never a revision
  const ready = gen.available && gen.revision && route.ready && version.mime !== 'video/mp4'
  const history = h(AttemptList, { key: 'hist', label: 'Revision attempts from this version', attempts, versions, onOpen, onCompare, onCheck, onSend, onCancel, canSend: ready && !generating })
  if (!b || !ready) return attempts.length ? el('section', { className: 'rt-gen', 'aria-label': 'Revision attempts' }, history) : null
  return el('section', { className: 'rt-gen', 'aria-label': 'Confirm revision', ref: box },
    el('h4', { className: 'rt-sec-title' }, 'Generate revision'),
    routeNote(route),
    el('div', { className: 'rt-gen-ref', role: 'group', 'aria-label': 'Reference and request' },
      h(Thumb, { scope, version }),
      el('div', {}, el('p', {}, 'Reference · this exact version'), el('p', { className: 'rt-muted' }, `${plural(b.annotations?.length || 0, 'note')} included`)),
      el('dl', { className: 'rt-brief-quote', style: { gridColumn: '1 / -1' } },
        el('div', {}, el('dt', { className: 'rt-eyebrow' }, 'Change'), el('dd', {}, b.change)),
        el('div', {}, el('dt', { className: 'rt-eyebrow' }, 'Keep'), el('dd', {}, b.preserve)))),
    el('p', { className: 'rt-why' }, 'Reference-guided, not masked editing: noted regions are sent as text guidance, so other areas may still change.'),
    aspectField(aspect, setAspect),
    h(ModelField, { picks, revision: true, value: model, onChange: setModel }),
    ...genSummary(gen, '', [['Creates', 'Next version of this asset · parent kept']]),
    blocked && !generating ? el('p', { className: 'rt-why', role: 'status' }, 'Another generation is reserved or running.') : null,
    el('div', { className: 'rt-confirm', role: 'group', 'aria-label': 'Confirm revision' },
      ...confirmText(gen, `Reserves this version’s original image and this request${sel ? ` for ${sel.display}` : ''}, then runs it once.`),
      el('div', { className: 'rt-row' },
        btn(generating ? 'Generating…' : 'Generate revision with Hermes', () => onGenerate({ kind: 'revision', parentId: version.id, briefId: b.id, aspect, selection: sel?.id || '' }), { variant: undefined, disabled: blocked || !!generating }),
        btn('Back', onBack, { disabled: !!generating }))),
    history)
}

// Assets are the exact stored asset_id groups. The label is the asset's original (root) filename,
// a display convenience only; it is not stored metadata and never rewrites anything.
function groupAssets(versions, names = {}) {
  const groups = new Map()
  for (const v of versions) { if (!groups.has(v.asset_id)) groups.set(v.asset_id, []); groups.get(v.asset_id).push(v) }
  const assets = [...groups].map(([id, items]) => ({ id, items, root: items.find(v => !v.parent_id) || items[0] }))
  const seen = new Map()
  for (const a of assets) seen.set(a.root.name, (seen.get(a.root.name) || 0) + 1)
  assets.forEach((a, i) => { a.n = i + 1; a.named = typeof names[a.id] === 'string' && !!names[a.id]; a.label = a.named ? names[a.id] : hashName(a.root.name) ? `Asset ${a.n}` : seen.get(a.root.name) > 1 ? `${a.root.name} · ${shortId(a.id)}` : a.root.name })
  return assets
}

// Arrow/Home/End keyboard support shared by every tablist.
const tabKeys = e => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
  if (!step && e.key !== 'Home' && e.key !== 'End') return
  const tabs = [...e.currentTarget.closest('[role=tablist]').querySelectorAll('[role=tab]:not(:disabled)')]
  const i = tabs.indexOf(e.currentTarget)
  const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : tabs[(i + step + tabs.length) % tabs.length]
  if (!next) return
  e.preventDefault(); next.focus(); next.click()
}

// Full original media through bounded public ctx.rest JSON; used only for the stage and Compare.
function Media({ scope, version, variant = 'stage', region, saved = false, marks = [], onRegion, onTime }) {
  const [drag, setDrag] = useState(null)
  const start = useRef(null)
  const media = useQuery({ queryKey: [...scope.key, 'media', version.id], queryFn: () => scope.read(`/projects/${enc(version.project_id)}/versions/${enc(version.id)}/media`), staleTime: 60000, retry: false })
  const stage = variant === 'stage'
  if (media.isPending || media.isLoading) return el('div', { className: 'rt-wait', 'aria-busy': 'true' }, el('span', { className: 'rt-spin', 'aria-hidden': 'true' }), 'Loading media…')
  if (media.error) return el('div', { className: 'rt-wait', 'data-kind': 'error', role: 'status' }, el('strong', {}, 'Media unavailable'), el('span', { className: 'rt-muted' }, text(media.error)), btn('Reload media', () => media.refetch?.()))
  const payload = media.data
  if (!payload || !MEDIA_MIME.test(payload.mime) || typeof payload.base64 !== 'string' || payload.base64.length > 46000000) return el('div', { className: 'rt-wait', 'data-kind': 'error', role: 'status' }, el('strong', {}, 'Unsupported media'), el('span', { className: 'rt-muted' }, 'Retake shows PNG, JPEG, WebP and MP4 originals.'))
  const src = `data:${payload.mime};base64,${payload.base64}`
  const image = payload.mime.startsWith('image/')
  const draw = stage && image
  const point = e => { const r = e.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) } }
  const box = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
  const chosen = drag || region
  return el('div', { className: stage ? 'rt-media' : 'rt-fit', 'data-draw': draw ? 'true' : undefined,
    onPointerDown: draw ? e => { if (e.button !== 0) return; start.current = point(e); e.currentTarget.setPointerCapture(e.pointerId) } : undefined,
    onPointerMove: draw ? e => { if (start.current) setDrag(box(start.current, point(e))) } : undefined,
    onPointerUp: draw ? e => { if (!start.current) return; const b = box(start.current, point(e)); start.current = null; setDrag(null); if (b.width > .005 && b.height > .005) onRegion(b) } : undefined,
    onPointerCancel: draw ? () => { start.current = null; setDrag(null) } : undefined
  }, image ? h('img', { src, alt: version.name, draggable: false }) : h('video', { src, controls: true, preload: 'metadata', 'aria-label': version.name, onTimeUpdate: stage ? e => onTime?.(e.currentTarget.currentTime) : undefined }),
  // Every saved region note of this version, numbered as in the Notes list. Outlines only: no fill, no masking.
  ...(draw ? marks.map(m => h('div', { key: m.id, className: 'rt-mark', 'data-active': m.active ? 'true' : undefined, 'aria-hidden': 'true', style: { left: `${m.region.x * 100}%`, top: `${m.region.y * 100}%`, width: `${m.region.width * 100}%`, height: `${m.region.height * 100}%` } }, h('span', { className: 'rt-mark-n' }, m.n))) : []),
  draw && chosen ? h('div', { className: 'rt-region', 'data-saved': saved && !drag ? 'true' : undefined, style: { left: `${chosen.x * 100}%`, top: `${chosen.y * 100}%`, width: `${chosen.width * 100}%`, height: `${chosen.height * 100}%` } }) : null)
}

// Download the exact stored original of ONE version, from the same bounded /media read the stage uses
// (shared query key, so no extra request in the host). Never the thumbnail, never another version.
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4' }
const downloadName = (version, mime) => {
  const name = String(version.name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').trim()
  return name || `retake-${String(version.id).slice(0, 8)}.${EXT[mime] || 'bin'}`
}
function Download({ scope, version, compact = false }) {
  const media = useQuery({ queryKey: [...scope.key, 'media', version.id], queryFn: () => scope.read(`/projects/${enc(version.project_id)}/versions/${enc(version.id)}/media`), staleTime: 60000, retry: false })
  const p = media.data
  const ok = !!p && MEDIA_MIME.test(p.mime) && typeof p.base64 === 'string'
  const save = () => {
    if (!ok || !scope.current()) return
    try {
      const raw = atob(p.base64), bytes = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
      const url = URL.createObjectURL(new Blob([bytes], { type: p.mime }))
      const a = document.createElement('a')
      a.href = url; a.download = downloadName(version, p.mime); a.rel = 'noopener'; a.style.display = 'none'
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30000)
    } catch (e) { host.notify({ kind: 'error', message: `Download failed: ${text(e)}` }) }
  }
  const pending = media.isPending || media.isLoading
  return el('button', { type: 'button', className: compact ? 'rt-dl rt-dl-sm' : 'rt-dl', disabled: !ok, onClick: save, 'aria-label': `Download ${version.name}`,
    title: ok ? `Download the original file · ${downloadName(version, p.mime)}` : pending ? 'Loading the original…' : 'Original unavailable' }, icon(ICON.download), el('span', {}, 'Download'))
}

// Bounded PNG thumbnail (backend-limited to 240×180, 256 KiB). Video gets an honest glyph, never a frame grab.
function Thumb({ scope, version, className = 'rt-thumb', fallback }) {
  const video = version.mime === 'video/mp4'
  const thumb = useQuery({ queryKey: [...scope.key, 'thumb', version.project_id, version.id], queryFn: () => scope.read(`/projects/${enc(version.project_id)}/versions/${enc(version.id)}/thumbnail`), enabled: !video, staleTime: Infinity, retry: false })
  const t = thumb.data
  const ok = !video && t && t.kind === 'image' && t.mime === 'image/png' && typeof t.base64 === 'string' && t.base64.length <= THUMB_B64_LIMIT
  const content = ok ? h('img', { src: `data:image/png;base64,${t.base64}`, alt: '', draggable: false })
    : video ? [icon(ICON.video), fallback ?? 'Video']
    : fallback ?? (thumb.error ? 'No preview' : '')
  return el('span', { className, 'data-kind': ok ? 'image' : video ? 'video' : 'none', 'aria-hidden': 'true' }, content)
}

function Cover({ scope, project }) {
  const v = project.cover_version
  const usable = v && typeof v.id === 'string' && v.project_id === project.id && /^image\/(png|jpeg|webp)$/.test(v.mime)
  if (!usable) return el('span', { className: 'rt-cover', 'data-kind': 'initials', 'aria-hidden': 'true' }, initials(project.name))
  return h(Thumb, { scope, version: v, className: 'rt-cover', fallback: initials(project.name) })
}

// Stage + inspector for exactly one version. Keyed by version id; unfinished input is cached per version.
function Review({ scope, version, versions, assetLabel, ordinalOf = () => '', detail, act, busy, drafts, tab, setTab, fieldsOpen, setFieldsOpen, gen, route, generating, blocked, onGenerate, picks, attempts, panel, onOpen, onCompare, onCheck, onSend, onCancel }) {
  const kept = drafts.current.get(version.id) || {}
  const [note, setNote] = useState(kept.note || '')
  // Draw-first: no box until the user drags one (or an unfinished one is restored for this version).
  const [region, setRegion] = useState(kept.region || null)
  const [timestamp, setTimestamp] = useState(kept.timestamp ?? 0)
  const [change, setChange] = useState(kept.change || '')
  const [preserve, setPreserve] = useState(kept.preserve || '')
  const [inspected, setInspected] = useState(null)
  const [briefId, setBriefId] = useState('')
  const [reviseFor, setReviseFor] = useState('') // saved request awaiting the generation confirm step
  const [statusMenu, setStatusMenu] = useState(false)
  useEffect(() => { drafts.current.set(version.id, { note, change, preserve, region, timestamp }) }, [note, change, preserve, region, timestamp])
  const forget = keys => { const d = drafts.current.get(version.id); if (d) for (const k of keys) d[k] = '' }
  const shownRegion = inspected?.region || region
  const newRegion = value => { setInspected(null); setRegion(value) }
  const compose = useRef(null)
  const [drawn, setDrawn] = useState(0) // bumps on each finished drag, to focus the note box once it renders
  useEffect(() => { if (drawn) compose.current?.querySelector('textarea')?.focus() }, [drawn])
  const discard = () => { setInspected(null); setRegion(null); setNote(''); forget(['note']) }
  const parentVersion = version.parent_id ? versions.find(x => x.id === version.parent_id) : null
  const video = version.mime === 'video/mp4'
  const base = `/projects/${enc(version.project_id)}/versions/${enc(version.id)}`
  const annotations = detail.annotations.filter(a => a.version_id === version.id)
  const briefs = detail.briefs.filter(b => b.version_id === version.id)
  const brief = useQuery({ queryKey: [...scope.key, 'brief', version.project_id, briefId], queryFn: () => scope.read(`/projects/${enc(version.project_id)}/briefs/${enc(briefId)}`), enabled: !!briefId, retry: false })
  const validRegion = !!region && Object.values(region).every(Number.isFinite) && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 && region.x + region.width <= 1.000001 && region.y + region.height <= 1.000001
  const validTime = Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= Math.min(120, version.duration ?? 120)
  const canAdd = !busy && !inspected && !!note.trim() && (video ? validTime : validRegion)
  const addNote = () => act({ path: `${base}/annotations`, body: video ? { kind: 'timestamp', note: note.trim(), timestamp } : { kind: 'region', note: note.trim(), region },
    after: () => { forget(['note']); setNote(''); if (!video) setRegion(null) } })
  const copy = async () => { try { scope.assert(); await navigator.clipboard.writeText(JSON.stringify(brief.data, null, 2)); scope.assert() } catch (e) { if (scope.current()) host.notify({ kind: 'error', message: text(e) }) } }

  const stage = el('section', { key: 'stage', className: 'rt-main', 'aria-label': 'Version review', 'aria-busy': busy },
    el('header', { className: 'rt-bar' },
      el('div', { className: 'rt-bar-title' },
        ordinalOf(version) ? el('span', { className: 'rt-bar-v', title: 'Display order within this asset (not stored)' }, ordinalOf(version)) : null,
        el('h3', { className: 'rt-trunc', title: version.name }, assetLabel),
        // The version's label, shown exactly like the card chip; clicking it changes the label.
        el('span', { className: 'rt-menu-wrap', role: 'group', 'aria-label': 'Review status', onKeyDown: e => { if (e.key === 'Escape') setStatusMenu(false) },
          onBlur: e => { if (!e.currentTarget.contains(e.relatedTarget)) setStatusMenu(false) } },
          el('button', { type: 'button', className: 'rt-status-btn', 'data-status': version.status, disabled: busy, 'aria-haspopup': 'menu', 'aria-expanded': statusMenu,
            'aria-label': `Status: ${STATUS[version.status] || version.status}. Change`, title: 'Change this version’s label', onClick: () => setStatusMenu(!statusMenu) },
            status(version.status), el('span', { className: 'rt-caret', 'aria-hidden': 'true' }, '▾')),
          statusMenu ? el('div', { className: 'rt-menu', role: 'menu', 'aria-label': 'Label this version' },
            ...[['selected', 'Approved', 'The pick for this asset'], ['needs_revision', 'Needs changes'], ['rejected', 'Rejected']].map(([s, label, hint]) => el('button', { key: s, type: 'button', role: 'menuitemradio', 'aria-checked': version.status === s, title: hint,
              onClick: () => { setStatusMenu(false); if (version.status !== s) act({ path: `${base}/review`, body: { status: s }, done: r => {
                const was = (r?.unapproved || []).map(id => ordinalOf(versions.find(x => x.id === id) || {})).filter(Boolean)
                return was.length ? { kind: 'ok', head: 'Approved. ', text: `${ordinalOf(version)} is now the pick for ${assetLabel}; ${was.join(', ')} ${was.length === 1 ? 'is' : 'are'} back to Needs changes.` } : null
              } }) } }, el('span', { className: 'rt-mcheck', 'aria-hidden': 'true' }, version.status === s ? '✓' : ''), label))) : null),
        version.width && version.height ? el('span', { className: 'rt-bar-dim', title: 'Stored pixel dimensions' }, `${version.width}×${version.height}`) : null,
        h(Download, { scope, version }),
        // The asset is already named in the breadcrumb; the relation uses ordinals, not a repeated filename.
        el('p', { className: 'rt-muted rt-bar-meta', title: `Asset · ${assetLabel} · ${lineage(version, versions)}` }, [!version.parent_id ? 'Original' : parentVersion ? `Revision of ${ordinalOf(parentVersion) || parentVersion.name}` : 'Revision', facts(version)].filter(Boolean).join(' · ')))),
    el('div', { className: 'rt-stage' }, h(Media, { scope, version, region: video ? null : shownRegion, saved: !!inspected, onRegion: b => { newRegion(b); setDrawn(n => n + 1) }, onTime: setTimestamp,
      marks: annotations.map((a, i) => ({ id: a.id, n: i + 1, region: a.region, active: inspected?.id === a.id })).filter(m => m.region && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(m.region[k]))) })))

  const notesPanel = [
    el('h4', { key: 'nh', className: 'rt-sec-title' }, `Notes on the image${annotations.length ? ` · ${annotations.length}` : ''}`),
    annotations.length || !video ? null : el('p', { key: 'none', className: 'rt-muted' }, 'No notes yet. Pause the video, then save a timestamp note.'),
    annotations.length === 0 ? null : el('ol', { key: 'list', className: 'rt-notes', 'aria-label': 'Saved notes' }, ...annotations.map((a, i) => {
      const active = inspected?.id === a.id
      // Same number as the marker drawn on the media; a region note's whole row toggles that region on the media.
      const body = [el('span', { key: 'k', className: 'rt-note-kind' }, el('span', { className: 'rt-note-n', 'aria-label': `Note ${i + 1}` }, i + 1), a.kind === 'timestamp' ? ` ${Number(a.timestamp).toFixed(1)}s` : null),
        el('span', { key: 't', className: 'rt-note-text' }, a.note)]
      return el('li', { key: a.id, 'data-active': active ? 'true' : undefined }, a.kind === 'region'
        ? el('button', { type: 'button', className: 'rt-note', onClick: () => setInspected(active ? null : a), 'aria-label': `Show region: ${a.note}`, 'aria-pressed': active }, ...body)
        : el('div', { className: 'rt-note' }, ...body))
    })),
    // Images: the form exists only once a box is drawn (or a saved region is inspected). Video: always.
    !video && !shownRegion ? el('p', { key: 'hint', className: 'rt-muted rt-draw-hint' }, 'Drag on the image to add a note.') :
    el('div', { key: 'compose', ref: compose, className: 'rt-compose rt-compose-sticky', role: 'group', 'aria-label': 'New note',
      onKeyDown: video || inspected ? undefined : e => { if (e.key === 'Escape') { e.preventDefault(); discard() } } },
      el('h5', { className: 'rt-sec-title' }, 'New note'),
      inspected && el('div', { className: 'rt-inspect' }, el('span', { role: 'status' }, 'Showing a saved region, read-only.'), btn('New region selection', () => { setInspected(null); setRegion(null) })),
      video ? field('Time (seconds)', timestamp, v => setTimestamp(Number(v)), { type: 'number', min: 0, max: Math.min(120, version.duration ?? 120), step: .1 }) : null,
      // The heading names the box; "Note" stays its accessible label.
      el('label', {}, el('span', { className: 'rt-sr' }, 'Note'), h(Textarea, { 'aria-label': 'Note', value: note, placeholder: video ? 'Pause the video, then describe the change' : 'Describe the change', onChange: e => setNote(e.target.value),
        onKeyDown: e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) { e.preventDefault(); if (canAdd) addNote() } } })),
      el('div', { className: 'rt-compose-foot' },
        video ? null : el('details', { className: 'rt-details', open: fieldsOpen, onToggle: e => setFieldsOpen(e.currentTarget.open) },
          el('summary', {}, 'Exact position'),
          el('div', { className: 'rt-numbers' }, ...['x', 'y', 'width', 'height'].map(k => field(k, shownRegion[k], v => newRegion({ ...region, [k]: Number(v) }), { key: k, type: 'number', min: 0, max: 1, step: .01, disabled: !!inspected })))),
        el('div', { className: 'rt-row' },
          video || inspected ? null : btn('Cancel', discard, { disabled: busy }),
          btn('Add note', addNote, { variant: undefined, disabled: !canAdd }))))
  ]

  const snapshots = brief.data?.annotations?.length ?? 0
  const opened = !briefId ? null : brief.error ? el('p', { role: 'alert', className: 'rt-muted' }, text(brief.error)) : brief.data ? el('article', { className: 'rt-brief', 'aria-label': 'Saved request' },
    el('div', { className: 'rt-row rt-between' }, el('span', {}), btn('Copy JSON', copy, { 'aria-label': 'Copy request JSON' })),
    el('dl', {}, el('div', {}, el('dt', { className: 'rt-eyebrow' }, 'Change'), el('dd', {}, brief.data.change)), el('div', {}, el('dt', { className: 'rt-eyebrow' }, 'Preserve'), el('dd', {}, brief.data.preserve))),
    el('p', { className: 'rt-muted', title: 'A fixed copy, taken at save, of the notes this version had then.' }, `${plural(snapshots, 'note')} · version `, el('span', { className: 'rt-id' }, brief.data.version_id))) : el('p', { role: 'status', className: 'rt-muted' }, 'Loading…')
  // Saving a request snapshots this version's notes with the text. Generate saves first, then opens the confirm step.
  // With notes saved, empty boxes fall back to these defaults (shown as placeholders) so the stored brief has real text.
  const defaults = annotations.length ? { change: 'Apply the numbered notes.', preserve: 'Everything not marked.' } : { change: '', preserve: '' }
  const requestBody = { change: change.trim() || defaults.change, preserve: preserve.trim() || defaults.preserve }
  const requestReady = !!(requestBody.change && requestBody.preserve)
  const saveRequest = generate => act({ path: `${base}/briefs`, body: requestBody, after:b => { forget(['change', 'preserve']); setChange(''); setPreserve(''); setBriefId(''); if (generate) setReviseFor(b.id) } })
  const canGenerate = gen.available && gen.revision && !video
  const noteRange = annotations.length === 0 ? 'No notes yet; the request is sent as text only.' : annotations.length === 1 ? 'Sends note 1 with this request.' : `Sends notes 1–${annotations.length} with this request.`
  const requestPanel = [
    el('h4', { key: 'rh', className: 'rt-sec-title' }, 'Revision request'),
    el('div', { key: 'request', className: 'rt-compose', role: 'group', 'aria-label': 'Revision request' },
      area('What should change?', change, setChange, undefined, defaults.change || undefined), area('What must stay?', preserve, setPreserve, undefined, defaults.preserve || undefined),
      el('p', { className: 'rt-muted' }, noteRange),
      !canGenerate ? el('p', { className: 'rt-muted', role: 'status' }, video ? 'Video versions can’t be generated; save the request and upload the revised file as the next version.' : gen.revisionReason || gen.reason || 'Automatic revision isn’t available here; save the request and upload the revised file as the next version.') : null,
      el('div', { className: 'rt-row rt-end' },
        btn('Save for later', () => saveRequest(false), { disabled: busy || !requestReady }),
        canGenerate ? btn('Generate revision…', () => saveRequest(true), { variant: undefined, className: 'rt-primary', disabled: busy || blocked || !requestReady }) : null)),
    h(ReviseSection, { key: 'revise', scope, gen, route, version, briefs, openedId: reviseFor, onBack: () => setReviseFor(''), generating, blocked, onGenerate, picks,
      attempts: attempts.filter(a => a.parent_id === version.id), versions, onOpen, onCompare, onCheck, onSend, onCancel }),
    briefs.length ? el('details', { key: 'earlier', className: 'rt-details rt-earlier' },
      el('summary', {}, `Earlier requests (${briefs.length})`),
      el('ul', { className: 'rt-drafts' }, ...briefs.map(b => el('li', { key: b.id },
        el('button', { type: 'button', className: 'rt-draft', 'aria-label': `Open request · ${b.change.slice(0, 55)}`, 'aria-pressed': briefId === b.id, onClick: () => setBriefId(briefId === b.id ? '' : b.id) }, el('span', { className: 'rt-trunc' }, b.change), when(b.created_at) ? el('span', { className: 'rt-muted' }, when(b.created_at)) : null),
        briefId === b.id ? el('div', { className: 'rt-earlier-open' }, opened, canGenerate ? el('div', { className: 'rt-row rt-end' }, btn('Generate revision…', () => setReviseFor(b.id), { variant: undefined, disabled: busy || blocked, 'aria-label': `Generate revision from request · ${b.change.slice(0, 55)}` })) : null) : null)))) : null
  ]

  const identity = [['Version', version.id], ['Parent', version.parent_id ? `${parentVersion ? `${parentVersion.name} · ` : ''}${version.parent_id}` : 'None · first version of this asset'], ['Asset', version.asset_id], ['SHA-256', version.sha256], ['Added', when(version.created_at)]].filter(([, v]) => v)
  const details = el('details', { className: 'rt-details rt-identity' },
    el('summary', {}, 'Version details'),
    el('dl', {}, ...identity.map(([k, v]) => el('div', { key: k, className: 'rt-identity-row' }, el('dt', {}, k), el('dd', { className: 'rt-id' }, v)))),
    el('p', { className: 'rt-muted' }, 'Uploads never overwrite this version. To revise it, upload a file as its next version.'))

  const inspector = el('section', { key: 'insp', className: 'rt-insp', role: 'region', 'aria-label': 'Review inspector' },
    el('div', { className: 'rt-insp-head' },
      el('h3', { className: 'rt-insp-title', id: 'retake-insp-title' }, 'Feedback')),
    el('div', { className: 'rt-insp-body', id: 'retake-insp-panel', role: 'group', 'aria-labelledby': 'retake-insp-title' },
      el('fieldset', { disabled: busy, 'aria-label': 'Feedback controls' }, ...notesPanel, ...requestPanel, details)))
  // The new-asset panel temporarily takes the inspector zone; Review drafts stay in the per-version cache.
  return [stage, panel || inspector]
}

function Workspace({ ctx, profile, epoch }) {
  const client = useQueryClient()
  const [pid, setPidState] = useState('')
  const projectRef = useRef('')
  const setPid = id => { projectRef.current = id; setPidState(id) }
  const [projectName, setProjectName] = useState('')
  const [active, setActive] = useState('')
  const [compare, setCompare] = useState([])
  const [message, setMessage] = useState(null)
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState('review')
  // 'auto': a project with several assets opens on its overview; one asset opens straight into it.
  const [view, setView] = useState('auto')
  const [menu, setMenu] = useState(null) // { id, top, left } of the rail project whose actions menu is open
  const [renamingProject, setRenamingProject] = useState('') // project id whose name is being edited in the rail
  const [newMenu, setNewMenu] = useState(false)
  const [renaming, setRenaming] = useState('') // asset id whose name is being edited
  const [deleting, setDeletingState] = useState(null) // { id, name } of the project awaiting explicit confirmation
  const [deleteError, setDeleteError] = useState('')
  const setDeleting = target => { setDeleteError(''); setDeletingState(target) }
  const [tab, setTab] = useState('notes')
  const [fieldsOpen, setFieldsOpen] = useState(false)
  const [railPref, setRailPref] = useState(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  const mounted = useRef(true)
  const lock = useRef(false)
  const root = useRef(null)
  const drafts = useRef(new Map())
  const viewed = useRef(new Map())
  const focusNew = useRef(false)
  // Generation state is scope-local: this component is keyed by source/profile/epoch, so a switch discards it.
  const [composer, setComposer] = useState(false)
  const [genPrompt, setGenPrompt] = useState('')
  const [genAspect, setGenAspect] = useState('landscape')
  const [genModel, setGenModel] = useState('')
  const [generating, setGenerating] = useState(null)
  // An attempt whose answer was lost (or that was already running when the page opened). Retake only READS
  // its record until it settles, then reports that same attempt; it never re-sends it.
  const [watch, setWatch] = useState(null)
  const genLock = useRef(false)
  const requestIds = useRef(new Map()) // frozen request fingerprint -> client_request_id until a durable answer arrives
  const activeRef = useRef('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  // Measure the route container itself (docked panes can be narrow inside a wide window).
  useLayoutEffect(() => {
    const node = root.current
    if (!node) return
    const measure = () => { const w = node.offsetWidth, h = node.offsetHeight; setWidth(old => Math.abs(old - w) < 1 ? old : w); setHeight(old => Math.abs(old - h) < 1 ? old : h) }
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const narrow = width > 0 && width < NARROW_ROOT
  useEffect(() => { setRailPref(null) }, [narrow])
  const railCollapsed = railPref ? railPref === 'closed' : narrow
  const dock = width > 0 && width - (railCollapsed ? RAIL_SHUT : RAIL_OPEN) < BOTTOM_DOCK ? 'bottom' : 'right'
  useEffect(() => { if (focusNew.current && !railCollapsed) { focusNew.current = false; root.current?.querySelector('#retake-new-project')?.focus() } }, [railCollapsed])

  const current = () => mounted.current && host.state.profile.get() === profile && gatewayActivationEpoch() === epoch
  const scope = { key: [ctx.source, profile, epoch], current, assert: () => { if (!current()) throw new Error('Profile or source changed. Reopen Retake before continuing.') } }
  scope.read = async path => { scope.assert(); const data = await ctx.rest(path); scope.assert(); return data }
  const [fastPoll, setFastPoll] = useState(false) // read-only polling while an attempt is active; never dispatches
  const projects = useQuery({ queryKey: [...scope.key, 'projects'], queryFn: () => scope.read('/projects'), retry: false, refetchInterval: 15000 })
  const detail = useQuery({ queryKey: [...scope.key, 'project', pid], queryFn: () => scope.read(`/projects/${enc(pid)}`), enabled: !!pid, retry: false, refetchInterval: fastPoll ? 3000 : 15000 })
  const mutation = useMutation({ mutationFn: async job => {
    scope.assert()
    let options = { method: 'POST', body: job.body }
    if (job.file) {
      const f = job.file
      const limit = f.type === 'video/mp4' ? 32 * 1024 * 1024 : 12 * 1024 * 1024
      if (!UPLOAD_MIMES.includes(f.type)) throw new Error(VIDEO_UPLOADS ? 'Use PNG, JPEG, WebP, or MP4.' : 'Use PNG, JPEG or WebP.')
      if (!f.size || f.size > limit) throw new Error(VIDEO_UPLOADS ? 'File is empty or exceeds the size limit (images 12 MB; video 32 MB).' : 'File is empty or exceeds the 12 MB limit.')
      const data = await fileBase64(f)
      scope.assert()
      options = { method: 'POST', body: { filename: f.name, content_type: f.type, data_base64: data }, timeoutMs: UPLOAD_TIMEOUT_MS }
    }
    scope.assert()
    const result = await ctx.rest(job.path, options)
    scope.assert()
    return result
  } })
  // The lock spans the POST, the awaited invalidation and the completion callback.
  const act = async job => {
    if (!current() || lock.current) return
    lock.current = true
    setSaving(true)
    setMessage(null)
    try {
      const result = await mutation.mutateAsync(job)
      scope.assert()
      await client.invalidateQueries({ queryKey: scope.key })
      scope.assert()
      job.after?.(result)
      const done = job.done?.(result)
      if (done) setMessage(done); else setMessage({ kind: 'ok', quiet: !job.file, text: job.file ? 'Version uploaded. Original files and review history are retained.' : 'Saved.' })
    } catch (e) { if (current()) setMessage({ kind: 'error', text: text(e) }) } finally { lock.current = false; if (current()) setSaving(false) }
  }

  // Metadata only: the backend route is static and never generates or checks sign-in.
  const capsQuery = useQuery({ queryKey: [...scope.key, 'generation-capabilities'], queryFn: () => scope.read('/generation-capabilities'), retry: false, staleTime: 60000 })
  const gen = capabilities(capsQuery)
  // Read-only listing from Hermes for this profile; never generates. Unsupported => no picker, flow unchanged.
  const selQuery = useQuery({ queryKey: [...scope.key, 'image-selections'], queryFn: () => scope.read('/image-selections'), enabled: !!pid && gen.available, retry: false, staleTime: 60000 })
  const picks = { supported: selQuery.data?.supported === true && Array.isArray(selQuery.data.selections), list: Array.isArray(selQuery.data?.selections) ? selQuery.data.selections.filter(d => d && typeof d.id === 'string' && typeof d.display === 'string') : [] }
  // The backend that answers this page's REST calls runs the attempt in the profile it authenticated.
  const route = { ready: true, key: `direct:${profile}`, label: `Hermes profile ${profile}` }
  // Captured at confirm, rechecked after reservation; a profile, epoch, source or project change means "reserved, not run".
  const identity = () => ({ key: route.key, profile: host.state.profile.get(), epoch: gatewayActivationEpoch(), source: ctx.source, project: projectRef.current })
  const sameIdentity = (a, b) => !!a.key && a.key === b.key && a.profile === b.profile && a.epoch === b.epoch && a.source === b.source && a.project === b.project
  const readAttempt = async (projectId, attemptId) => {
    const r = await scope.read(`/projects/${enc(projectId)}/generations/${enc(attemptId)}`)
    return r && typeof r === 'object' && r.attempt && r.attempt.id === attemptId ? r.attempt : null
  }
  const stillChecking = (id, lost) => setMessage({ kind: 'ok', head: 'Still checking. ', text: `${lost ? `The answer for attempt ${shortId(id)} was lost; Hermes may still be generating it.` : `Retake could not read attempt ${shortId(id)} yet; it may still be generating.`} Retake keeps reading that attempt and will not send it again.` })
  const report = (attempt, spec, viewing, lostAnswer, attemptId = '') => {
    if (!attempt) return stillChecking(attemptId, lostAnswer)
    if (attempt.state === 'succeeded' && typeof attempt.version_id === 'string') {
      if (spec?.kind === 'new_asset') { setGenPrompt(''); setComposer(false) }
      if (activeRef.current === viewing) review(attempt.version_id)
      const by = [attempt.reported_provider, attempt.model].filter(Boolean).join(' · ')
      if (attempt.selection_mismatch) return setMessage({ kind: 'error', head: 'Generated, but not as chosen. ', text: `Stored as a new version (attempt ${shortId(attempt.id)}), but Hermes reported ${by || 'another model'}${attempt.fallback_from ? ` (fallback from ${attempt.fallback_from})` : ''} instead of ${attempt.image_selection?.display || 'the chosen model'}. Check it before use.` })
      return setMessage({ kind: 'ok', head: 'Generated. ', text: `Stored as a new version (attempt ${shortId(attempt.id)}${by ? `; tool reported ${by}, variant not verified` : ''}).${spec?.kind === 'revision' ? ' Tick it and its parent in Versions to compare.' : ''}` })
    }
    if (ACTIVE_ATTEMPT(attempt.state) && lostAnswer) return stillChecking(attempt.id, true)
    if (attempt.state === 'unknown') return setMessage({ kind: 'error', head: 'Outcome unknown. ', text: `No version was stored for attempt ${shortId(attempt.id)}, and Retake cannot tell whether it reached the provider; it may have been billed. ${attempt.error?.message || ''} Retake will not retry it.` })
    if (ACTIVE_ATTEMPT(attempt.state)) return setMessage({ kind: 'ok', head: 'Still generating. ', text: `Attempt ${shortId(attempt.id)} is ${attempt.state}. Retake keeps checking its record and will not send it again.` })
    return setMessage({ kind: 'error', head: 'No version created. ', text: `Attempt ${shortId(attempt.id)} · ${ATTEMPT[attempt.state] || 'unrecognized response'}. ${attempt.error?.message || ''} Not retried automatically.` })
  }
  // Ask the backend to claim and run ONE reserved attempt, then only READ its record until it settles.
  // A lost answer means "keep reading the record", never "send again"; the backend refuses a second run.
  const sendAttempt = async (projectId, attemptId, before, spec) => {
    if (!sameIdentity(before, identity())) {
      setMessage({ kind: 'error', head: 'Reserved, not run. ', text: `The profile or project changed before Retake ran attempt ${shortId(attemptId)}. Nothing was sent. Use Run on the reserved attempt, or Cancel reservation.` })
      return
    }
    const viewing = activeRef.current
    setFastPoll(true)
    setMessage({ kind: 'ok', head: 'Generating. ', text: `Running attempt ${shortId(attemptId)}. Keep working; do not resubmit.` })
    let lostAnswer = false, refused = ''
    try {
      scope.assert()
      const r = await ctx.rest(`/projects/${enc(projectId)}/generations/${enc(attemptId)}/run`, { method: 'POST', body: {} })
      if (r && r.started === false && typeof r.reason === 'string') refused = r.reason.slice(0, 300)
    } catch { lostAnswer = true; if (current() && projectRef.current === projectId) stillChecking(attemptId, true) }
    // A failed read is not an outcome: keep reading the SAME attempt (slower) until it settles or the deadline.
    let attempt = null, read = null
    const until = Date.now() + RUN_WAIT_MS
    while (current() && projectRef.current === projectId) {
      try { read = await readAttempt(projectId, attemptId) } catch { read = null }
      if (read) attempt = read
      if ((read && !ACTIVE_ATTEMPT(read.state)) || Date.now() > until || refused) break
      await new Promise(resolve => setTimeout(resolve, read ? 1500 : 3000))
    }
    if (!current()) return
    try { await client.invalidateQueries({ queryKey: scope.key }) } catch { /* the board refreshes on its own */ }
    if (projectRef.current !== projectId) return // the durable result stays in its origin project
    if (refused && attempt?.state === 'reserved') return setMessage({ kind: 'error', head: 'Not run. ', text: refused })
    // Still unsettled (or unreadable): hand the same attempt to the board watcher, which reports it once it settles.
    if (!attempt || ACTIVE_ATTEMPT(attempt.state)) setWatch({ projectId, attemptId, spec, viewing })
    report(attempt, spec, viewing, lostAnswer, attemptId)
  }
  // The ONLY generation path: an explicit confirmed click. Guarded synchronously against double clicks;
  // the request ID is reused if the reservation answer is lost, so re-confirming replays, never re-reserves.
  const runGeneration = async spec => {
    if (genLock.current || lock.current || !current() || !pid || !gen.available || !route.ready) return
    if (spec.kind === 'revision' && !gen.revision) return
    const before = identity()
    if (before.project !== pid) return
    genLock.current = true
    const projectId = pid
    const fingerprint = JSON.stringify([projectId, spec.kind, spec.prompt || '', spec.parentId || '', spec.briefId || '', spec.aspect, spec.selection || ''])
    let cid = requestIds.current.get(fingerprint)
    if (!cid) { cid = requestId(); requestIds.current.set(fingerprint, cid) }
    const body = { client_request_id: cid, confirmed: true, aspect_ratio: spec.aspect, ...(spec.kind === 'revision' ? { parent_id: spec.parentId, brief_id: spec.briefId } : { prompt: spec.prompt }), ...(spec.selection ? { image_selection: spec.selection } : {}) }
    setGenerating({ kind: spec.kind, parentId: spec.parentId || null })
    try {
      let attempt = null
      try {
        scope.assert()
        const result = await ctx.rest(`/projects/${enc(projectId)}/generations`, { method: 'POST', body })
        scope.assert()
        requestIds.current.delete(fingerprint) // durable answer: a deliberate later run gets a new ID
        attempt = result && typeof result === 'object' ? result.attempt : null
      } catch (e) {
        if (current() && projectRef.current === projectId) setMessage({ kind: 'error', head: 'Reservation answer not received. ', text: `${text(e)} Nothing was sent to Hermes. If the reservation was stored it appears below as Reserved; confirming the same inputs again reuses this request ID and cannot reserve twice.` })
        return
      }
      await client.invalidateQueries({ queryKey: scope.key })
      if (!current() || projectRef.current !== projectId) return
      if (!attempt || typeof attempt.id !== 'string') return setMessage({ kind: 'error', head: 'Unexpected answer. ', text: 'Retake did not return an attempt. Nothing was sent.' })
      if (attempt.state !== 'reserved') return report(attempt, spec, activeRef.current, false) // replayed: never re-dispatch
      await sendAttempt(projectId, attempt.id, before, spec)
    } finally { genLock.current = false; if (current()) setGenerating(null) }
  }
  // "Run" on an already reserved attempt (e.g. the profile or project changed before it ran).
  const sendReserved = async attemptId => {
    if (genLock.current || lock.current || !current() || !pid || !route.ready) return
    genLock.current = true
    setGenerating({ kind: 'send', parentId: null })
    try { await sendAttempt(pid, attemptId, identity(), null) } finally { genLock.current = false; if (current()) setGenerating(null) }
  }
  const cancelReserved = async attemptId => {
    if (genLock.current || lock.current || !current() || !pid) return
    const projectId = pid
    try {
      scope.assert()
      const r = await ctx.rest(`/projects/${enc(projectId)}/generations/${enc(attemptId)}/cancel`, { method: 'POST', body: {} })
      scope.assert()
      await client.invalidateQueries({ queryKey: scope.key })
      if (current() && projectRef.current === projectId) report(r?.attempt || null, null, activeRef.current, false)
    } catch (e) { if (current()) setMessage({ kind: 'error', text: text(e) }) }
  }

  // Ignore a detail payload that belongs to a previously opened project.
  const data = detail.data?.project?.id === pid ? detail.data : undefined
  const versions = data?.versions || []
  const assets = groupAssets(versions, data?.asset_names && typeof data.asset_names === 'object' ? data.asset_names : {})
  const selected = versions.find(v => v.id === active)
  const asset = assets.find(a => a.id === selected?.asset_id) || assets[0]
  const assetOf = v => assets.find(a => a.id === v.asset_id)
  const showOverview = !!data && versions.length > 0 && mode === 'review' && (view === 'overview' || (view === 'auto' && assets.length > 1))
  const busy = mutation.isPending || saving
  activeRef.current = active
  const attempts = Array.isArray(data?.attempts) ? data.attempts.filter(a => a && typeof a.id === 'string' && typeof a.state === 'string') : []
  const runningAttempts = attempts.filter(a => ACTIVE_ATTEMPT(a.state))
  const genBlocked = !!generating || !!watch || runningAttempts.length > 0
  // Reserved, running or unknown: a late result could still land, so the project cannot be deleted yet.
  const openAttempts = attempts.filter(a => ['reserved', 'running', 'unknown'].includes(a.state)).length
  const anyRunning = runningAttempts.some(a => a.state === 'running')
  useEffect(() => { setFastPoll(anyRunning || !!generating || !!watch) }, [anyRunning, generating, watch])
  // Follows the watched attempt on every board read; also adopts an attempt already running when the page
  // opens (e.g. after a reload), so its stored result is announced instead of looking lost.
  useEffect(() => {
    if (!data || generating) return
    if (watch) {
      const a = watch.projectId === data.project.id ? attempts.find(x => x.id === watch.attemptId) : null
      if (a && !ACTIVE_ATTEMPT(a.state)) { setWatch(null); report(a, watch.spec, watch.viewing, false) }
      return
    }
    const running = runningAttempts.find(a => a.state === 'running')
    if (running) setWatch({ projectId: data.project.id, attemptId: running.id, spec: null, viewing: activeRef.current })
  }, [data, watch, generating])
  const ordinal = v => { const i = assetOf(v)?.items.indexOf(v) ?? -1; return i >= 0 ? `v${i + 1}` : '' }
  const openVersion = id => { if (lock.current || !versions.some(v => v.id === id)) return; setComposer(false); review(id) }
  const compareWithParent = (parentId, id) => { if (lock.current) return; setCompare([parentId, id]); setMode('compare') }
  const checkStatus = () => { detail.refetch() } // read-only re-read; never dispatches or retries
  const openComposer = () => { if (lock.current) return; setComposer(true); setMode('review') }
  // Revision is requested from the Feedback panel: bring its first field into view and focus it.
  const focusRevision = () => {
    if (lock.current) return; setComposer(false); setMode('review')
    setTimeout(() => { const t = root.current?.querySelector('textarea[aria-label="What should change?"]'); if (t) { t.scrollIntoView({ block: 'center' }); t.focus({ preventScroll: true }) } }, 0)
  }
  const genProps = { gen, route, generating, blocked: genBlocked, onGenerate: runGeneration, picks, attempts, onOpen: openVersion, onCompare: compareWithParent, onCheck: checkStatus, onSend: sendReserved, onCancel: cancelReserved }
  useEffect(() => { if (selected) viewed.current.set(selected.asset_id, selected.id) }, [selected?.id])
  // Only choose a default when no explicit version was requested. A post-upload ID can
  // arrive before the refreshed detail payload; never replace it with an older take.
  useEffect(() => { if (data && versions.length && !active && !lock.current) setActive(versions[versions.length - 1].id) }, [data, versions.length, active])

  const review = id => { setActive(id); setMode('review'); setView('asset') } // internal, e.g. post-upload auto-selection
  const navigateReview = id => { if (!lock.current) review(id) }
  const chooseMode = m => { if (!lock.current) setMode(m) }
  const chooseAsset = id => { if (lock.current) return; const a = assets.find(x => x.id === id); if (!a) return; const last = viewed.current.get(id); setActive(a.items.some(v => v.id === last) ? last : (pickOf(a) || a.items[a.items.length - 1]).id); setMode('review'); setView('asset') }
  const toOverview = () => { if (lock.current) return; setComposer(false); setMode('review'); setView('overview') }
  const switchProject = id => { if (lock.current) return; setPid(id); setActive(''); setCompare([]); setMode('review'); setView('auto'); setMenu(null); setDeleting(null); setMessage(null) }
  // Deletion is one explicit, confirmed DELETE through the profile router; the backend refuses (changing
  // nothing) while any attempt is reserved, running or of unknown outcome.
  const deleteProject = async target => {
    if (!target || lock.current || !current()) return
    lock.current = true; setSaving(true); setMessage(null); setDeleteError('')
    try {
      scope.assert()
      await ctx.rest(`/projects/${enc(target.id)}`, { method: 'DELETE', body: { confirm_name: target.name } })
      scope.assert()
      setDeleting(null)
      if (projectRef.current === target.id) { setPid(''); setActive(''); setCompare([]); setView('auto') }
      await client.invalidateQueries({ queryKey: scope.key })
      if (current()) setMessage({ kind: 'ok', head: 'Deleted. ', text: `Project “${target.name}” and everything in it were removed.` })
    } catch (e) { if (current()) setDeleteError(text(e)) } finally { lock.current = false; if (current()) setSaving(false) }
  }
  const toggleCompare = (id, checked) => setCompare(ids => checked ? [...ids.filter(x => x !== id), id].slice(0, 2) : ids.filter(x => x !== id))
  const list = projects.data?.projects || []

  // Project actions live on each rail row. The menu is anchored to the Retake root, not the scrolling list, so it is never clipped.
  const openProjectMenu = (p, button) => {
    if (menu?.id === p.id) return setMenu(null)
    const r = button.getBoundingClientRect(), box = root.current.getBoundingClientRect()
    setMenu({ id: p.id, top: r.bottom - box.top + 4, left: Math.max(8, Math.min(r.left - box.left, box.width - 188)) })
  }
  const saveProjectName = (p, value) => { setRenamingProject(''); const name = value.trim(); if (!name || name === p.name) return; act({ path: `/projects/${enc(p.id)}/name`, body: { name } }) }
  const projectMenu = () => {
    const p = list.find(x => x.id === menu?.id)
    if (!p || railCollapsed) return null
    // Only the open project's attempts are known here; for another project the server's refusal shows in the dialog.
    const blocked = data?.project.id === p.id && openAttempts > 0
    const trigger = () => [...(root.current?.querySelectorAll('[data-proj-menu]') || [])].find(b => b.dataset.projMenu === p.id)
    return el('div', { key: 'proj-menu', className: 'rt-menu', role: 'menu', 'aria-label': `Actions for ${p.name}`, style: { top: menu.top, left: menu.left },
      onKeyDown: e => { if (e.key === 'Escape') { e.preventDefault(); setMenu(null); trigger()?.focus() } },
      onBlur: e => { const t = e.relatedTarget; if (!e.currentTarget.contains(t) && t !== trigger()) setMenu(null) } },
      el('button', { type: 'button', role: 'menuitem', autoFocus: true, onClick: () => { setMenu(null); setRenamingProject(p.id) } }, 'Rename…'),
      el('button', { type: 'button', role: 'menuitem', disabled: blocked, 'aria-describedby': blocked ? 'retake-delete-why' : undefined, onClick: () => { setMenu(null); setDeleting({ id: p.id, name: p.name }) } }, 'Delete project…'),
      blocked ? el('span', { id: 'retake-delete-why', className: 'rt-menu-why' }, 'Unavailable while a generation is in progress.') : null)
  }

  const header = el('header', { className: 'rt-top' },
    el('nav', { className: 'rt-crumbs', 'aria-label': 'Breadcrumb' },
      // The root crumb is the page heading: it names the app and leads back to every project.
      el('h1', {}, el('button', { type: 'button', className: 'rt-crumb', disabled: busy, 'aria-current': pid ? undefined : 'page', title: 'All projects', onClick: () => switchProject('') }, 'Retake')),
      data ? [el('span', { key: 's1', className: 'rt-sep', 'aria-hidden': 'true' }, '›'),
        el('h2', { key: 'p', className: 'rt-trunc' }, el('button', { type: 'button', className: 'rt-crumb', disabled: busy, title: `${data.project.name} · all assets`, 'aria-current': showOverview ? 'page' : undefined, onClick: toOverview }, data.project.name))] : null,
      data && asset && !showOverview ? [el('span', { key: 's2', className: 'rt-sep', 'aria-hidden': 'true' }, '›'),
        // Option text is the asset name only, so the closed picker never clips mid-word; the filmstrip shows the count.
        // One asset: nothing to switch, so a plain name. Several: a labelled switcher (versions are the filmstrip).
        assets.length < 2 ? el('span', { key: 'a', className: 'rt-trunc rt-asset-name', title: `Asset · ${asset.label}` }, asset.label)
          : el('label', { key: 'a', className: 'rt-asset' },
            el('select', { 'aria-label': 'Asset', value: asset.id, disabled: busy, title: `Switch asset · ${plural(assets.length, 'asset')} in this project`, onChange: e => chooseAsset(e.target.value) },
              ...assets.map(a => el('option', { key: a.id, value: a.id, title: plural(a.items.length, 'version') }, a.label))))] : null),
    // Review | Compare act on one asset's versions, so they appear only while an asset is open.
    el('div', { className: 'rt-top-tools' },
      el('span', { className: 'rt-pill' }, `Profile · ${profile}`),
      pid ? el('button', { type: 'button', className: 'rt-icon', 'aria-label': 'Refresh', title: 'Refresh project', disabled: busy, onClick: () => detail.refetch() }, icon(ICON.refresh)) : null))

  const rail = el('aside', { className: 'rt-rail', 'aria-label': 'Projects', 'data-collapsed': railCollapsed ? 'true' : 'false' },
    el('div', { className: 'rt-rail-head' },
      el('h2', { className: railCollapsed ? 'rt-sr' : 'rt-eyebrow' }, 'Projects'),
      el('button', { type: 'button', className: 'rt-icon', 'aria-label': railCollapsed ? 'Expand projects' : 'Collapse projects', 'aria-expanded': !railCollapsed, onClick: () => setRailPref(railCollapsed ? 'open' : 'closed') }, icon(railCollapsed ? ICON.right : ICON.left))),
    projects.error && el('p', { role: 'alert', className: 'rt-muted' }, `Could not load projects: ${text(projects.error)}`),
    (projects.isPending || projects.isLoading) && el('p', { role: 'status', className: railCollapsed ? 'rt-sr' : 'rt-muted' }, 'Loading projects…'),
    list.length > 0 && el('ul', { className: 'rt-projects', onScroll: () => setMenu(null) }, ...list.map(p => renamingProject === p.id && !railCollapsed
      // Renaming swaps the row's name for a field: Enter or leaving the field saves, Escape cancels; empty or unchanged sends nothing.
      ? el('li', { key: p.id, className: 'rt-proj-item', 'data-editing': 'true' }, el('div', { className: 'rt-proj' }, h(Cover, { scope, project: p }),
        el('input', { className: 'rt-rename', 'aria-label': `Name for ${p.name}`, defaultValue: p.name, maxLength: 120, autoFocus: true,
          onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } else if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.dataset.cancel = '1'; setRenamingProject('') } },
          onBlur: e => { if (!e.currentTarget.dataset.cancel) saveProjectName(p, e.currentTarget.value) } })))
      : el('li', { key: p.id, className: 'rt-proj-item', 'data-current': p.id === pid ? 'true' : undefined },
        el('button', { className: 'rt-proj', type: 'button', disabled: busy, 'aria-pressed': p.id === pid, 'aria-label': p.name, title: p.name, onClick: () => switchProject(p.id) },
          h(Cover, { scope, project: p }), el('span', { className: 'rt-proj-name' }, p.name)),
        railCollapsed ? null : el('button', { type: 'button', className: 'rt-icon rt-proj-more', 'data-proj-menu': p.id, 'aria-label': `Actions for ${p.name}`, 'aria-haspopup': 'menu', 'aria-expanded': menu?.id === p.id, disabled: busy, onClick: e => openProjectMenu(p, e.currentTarget) }, '⋯')))),
    projects.data?.projects?.length === 0 && !railCollapsed && el('p', { className: 'rt-muted' }, 'Your first project starts here.'),
    railCollapsed
      ? el('button', { type: 'button', className: 'rt-icon rt-new-btn', 'aria-label': 'New project', title: 'New project', onClick: () => { focusNew.current = true; setRailPref('open') } }, icon(ICON.plus))
      : el('form', { className: 'rt-new', onSubmit: e => { e.preventDefault(); if (projectName.trim()) act({ path: '/projects', body: { name: projectName.trim() }, after: p => { setPid(p.id); setActive(''); setCompare([]); setMode('review'); setProjectName('') } }) } },
        field('New project name', projectName, setProjectName, { id: 'retake-new-project', maxLength: 120, required: true }),
        el(Button, { type: 'submit', disabled: busy || !projectName.trim(), size: 'sm' }, 'Create project')))

  const emptyMain = (key, ...content) => el('section', { key, className: 'rt-main rt-main-empty' }, ...content)
  // Shared empty / loading / error block: title, one sentence, optional actions.
  const emptyBox = ({ title, body, actions, kind, role }) => el('div', { className: 'rt-empty', 'data-kind': kind, role },
    kind === 'loading' ? el('span', { className: 'rt-spin', 'aria-hidden': 'true' }) : null,
    title ? el('p', { className: 'rt-empty-title' }, title) : null, body ? el('p', {}, body) : null,
    actions ? el('div', { className: 'rt-row' }, actions) : null)
  // Empty project: two choices. The upload tile is the file input's label and a drop target; both feed the same
  // JSON upload (type and size checked before any request) and open the new version.
  const uploadNew = f => { if (f) act({ path: `/projects/${enc(pid)}/versions`, file: f, after: v => review(v.id) }) }
  const dragOver = (e, on) => { e.preventDefault(); if (on || !e.currentTarget.contains(e.relatedTarget)) e.currentTarget.dataset.over = on ? 'true' : 'false' }
  const guide = () => emptyMain('guide', el('div', { className: 'rt-start' },
    el('h3', {}, 'Add your first asset'),
    el('p', { className: 'rt-start-sub' }, VIDEO_UPLOADS ? 'An image or short video to review and revise.' : 'An image to review and revise.'),
    el('div', { className: 'rt-choices' },
      el('label', { className: 'rt-choice rt-choice-drop', tabIndex: busy ? -1 : 0, 'data-disabled': busy ? 'true' : undefined,
        onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click() } },
        onDragOver: e => dragOver(e, true), onDragLeave: e => dragOver(e, false),
        onDrop: e => { dragOver(e, false); if (!busy) uploadNew(e.dataTransfer?.files?.[0]) } },
        el('span', { className: 'rt-choice-ic', 'aria-hidden': 'true' }, '↑'), el('b', {}, busy ? 'Saving…' : 'Upload a file'), el('small', {}, `or drop it here · ${UPLOAD_KINDS}`),
        el('input', { type: 'file', accept: UPLOAD_ACCEPT, 'aria-label': 'Upload a new asset', tabIndex: -1, disabled: busy, onChange: e => { const f = e.target.files?.[0]; e.target.value = ''; uploadNew(f) } })),
      el('button', { type: 'button', className: 'rt-choice', 'aria-label': 'Generate from a prompt', disabled: !gen.available || busy, title: gen.available ? undefined : gen.reason, onClick: openComposer },
        el('span', { className: 'rt-choice-ic', 'aria-hidden': 'true' }, '✦'), el('b', {}, 'Generate from a prompt'), el('small', {}, 'You confirm before anything is sent'))),
    el('ol', { className: 'rt-flow', 'aria-label': 'How it works' }, el('li', {}, 'Add an asset'), el('li', {}, 'Mark notes on it'), el('li', {}, 'Make the next version'))))

  const figure = (id, i) => {
    const v = versions.find(x => x.id === id)
    if (!v) return el('div', { key: `slot-${i}`, className: 'rt-slot' }, el('span', { className: 'rt-badge', 'aria-hidden': 'true' }, 'AB'[i]), `Choose version ${'AB'[i]} with its A/B chip in the filmstrip.`)
    // Caption: "A v2 filename · status" on one line; one muted line with the relation (by ordinal, not a repeated
    // filename) and file facts. The asset is named only when the two versions belong to different assets.
    const p = v.parent_id ? versions.find(x => x.id === v.parent_id) : null
    const rel = !v.parent_id ? 'Original' : p ? `Revision of ${ordinal(p) || p.name}` : 'Revision'
    const pair = compare.map(x => versions.find(y => y.id === x)).filter(Boolean)
    const crossAsset = new Set(pair.map(x => x.asset_id)).size > 1
    const meta = [crossAsset ? assetOf(v)?.label || shortId(v.asset_id) : '', rel, facts(v)].filter(Boolean).join(' · ')
    return el('figure', { key: id, className: 'rt-fig', 'aria-label': `Version ${'AB'[i]}: ${v.name}` },
      el('div', { className: 'rt-fig-frame' }, h(Media, { scope, version: v, variant: 'compare' })),
      el('figcaption', {},
        el('div', { className: 'rt-row' }, el('span', { className: 'rt-badge' }, 'AB'[i]), el('strong', { className: 'rt-fig-v', title: 'Display order within this asset (not stored)' }, ordinal(v) || 'v?'), status(v.status), h(Download, { scope, version: v, compact: true })),
        el('span', { className: 'rt-muted rt-trunc rt-fig-rel', title: [lineage(v, versions), `Asset · ${assetOf(v)?.label || shortId(v.asset_id)}`, facts(v)].join(' · ') }, meta),
        el('span', { className: 'rt-id rt-fig-id' }, v.id)))
  }
  const comparison = el('section', { key: 'compare', className: 'rt-main', 'aria-label': 'Compare versions' },
    el('header', { className: 'rt-bar' },
      el('div', { className: 'rt-bar-title' }, btn(`← Back to ${selected ? ordinal(selected) || 'review' : 'review'}`, () => chooseMode('review'), { className: 'rt-back' }), el('h3', {}, 'Compare'),
        el('p', { className: 'rt-muted rt-bar-meta' }, compare.length === 2 ? 'Original files · independent playback · no automatic winner' : `${compare.length} of 2 chosen · choices may span assets`)),
      compare.length ? btn('Clear comparison', () => setCompare([])) : null),
    el('div', { className: 'rt-cmp' }, figure(compare[0], 0), figure(compare[1], 1)))

  // Assets are the project's contents; versions belong to one asset. Each card opens that asset's versions.
  const saveName = (a, value) => { setRenaming(''); const name = value.trim(); if (name === (a.named ? a.label : '')) return; act({ path: `/projects/${enc(pid)}/assets/${enc(a.id)}/name`, body: { name } }) }
  const assetCard = a => {
    const latest = a.items[a.items.length - 1], pick = pickOf(a)
    const meta = el('span', { className: 'rt-asset-meta' }, el('span', {}, plural(a.items.length, 'version')), pick ? [status('selected'), el('span', { key: 'v' }, ordinal(pick))] : status(latest.status))
    // Renaming swaps the card's title for a field: Enter or leaving the field saves, Escape cancels, empty restores the default.
    if (renaming === a.id) return el('li', { key: a.id }, el('div', { className: 'rt-asset-card', 'data-editing': 'true' },
      h(Thumb, { scope, version: pick || latest }),
      el('span', { className: 'rt-asset-text' },
        el('input', { className: 'rt-rename', 'aria-label': `Name for ${a.label}`, defaultValue: a.named ? a.label : '', placeholder: a.label, maxLength: 120, autoFocus: true,
          onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } else if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.dataset.cancel = '1'; setRenaming('') } },
          onBlur: e => { if (!e.currentTarget.dataset.cancel) saveName(a, e.currentTarget.value) } }), meta)))
    // The approved pick represents the asset; without one, the latest version does.
    return el('li', { key: a.id, className: 'rt-asset-item' },
      el('button', { type: 'button', className: 'rt-asset-card', disabled: busy, 'aria-label': `Open ${a.label}`, title: `${a.label} · ${plural(a.items.length, 'version')} · ${a.root.name}`, onClick: () => chooseAsset(a.id) },
        h(Thumb, { scope, version: pick || latest }),
        el('span', { className: 'rt-asset-text' }, el('strong', { className: 'rt-trunc' }, a.label), meta)),
      el('button', { type: 'button', className: 'rt-icon rt-rename-btn', disabled: busy, 'aria-label': `Rename ${a.label}`, title: 'Rename', onClick: () => setRenaming(a.id) }, icon(ICON.edit)))
  }
  // First card: start a new asset by upload or generation (the overview has no bottom bar).
  const newAssetCard = () => el('li', { key: 'new', className: 'rt-asset-item', onKeyDown: e => { if (e.key === 'Escape') setNewMenu(false) }, onBlur: e => { if (!e.currentTarget.contains(e.relatedTarget)) setNewMenu(false) } },
    el('button', { type: 'button', className: 'rt-asset-card rt-new-card', disabled: busy, 'aria-haspopup': 'menu', 'aria-expanded': newMenu, onClick: () => setNewMenu(!newMenu) },
      el('span', { className: 'rt-thumb rt-new-plus', 'aria-hidden': 'true' }, '+'), el('span', { className: 'rt-asset-text' }, el('strong', {}, busy ? 'Saving…' : 'New asset'))),
    newMenu ? el('div', { className: 'rt-menu rt-new-menu', role: 'menu', 'aria-label': 'New asset' },
      el('label', { role: 'menuitem', className: 'rt-menu-file', tabIndex: 0, onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click() } } }, 'Upload a file…',
        el('input', { type: 'file', accept: UPLOAD_ACCEPT, 'aria-label': 'Upload a new asset', tabIndex: -1, onChange: e => { const f = e.target.files?.[0]; e.target.value = ''; setNewMenu(false); if (f) act({ path: `/projects/${enc(pid)}/versions`, file: f, after: v => review(v.id) }) } })),
      el('button', { type: 'button', role: 'menuitem', disabled: !gen.available, title: gen.available ? undefined : gen.reason, onClick: () => { setNewMenu(false); openComposer() } }, 'Generate from a prompt…')) : null)
  const pendingCard = a => el('li', { key: `attempt-${a.id}` }, el('div', { className: 'rt-asset-card', 'data-attempt': a.state, title: `Generation attempt ${a.id}` },
    el('span', { className: 'rt-thumb' }, a.state === 'reserved' ? 'Reserved…' : el('span', { className: 'rt-spin', 'aria-hidden': 'true' })),
    el('span', { className: 'rt-asset-text' }, el('strong', {}, a.state === 'reserved' ? 'Reserved' : 'Generating…'), el('span', { className: 'rt-muted' }, 'New asset'))))
  const overview = () => el('section', { key: 'overview', className: 'rt-main rt-overview', 'aria-label': 'Project overview' },
    el('header', { className: 'rt-bar' }, el('div', { className: 'rt-bar-title' }, el('h3', {}, 'Assets'), el('p', { className: 'rt-muted rt-bar-meta' }, `${plural(assets.length, 'asset')} · ${plural(versions.length, 'version')}`))),
    el('ul', { className: 'rt-assets', 'aria-label': 'Assets in this project' }, newAssetCard(), ...assets.map(assetCard), ...runningAttempts.filter(a => a.kind === 'new_asset').map(pendingCard)))
  const projectGrid = () => el('section', { key: 'projects', className: 'rt-main rt-overview', 'aria-label': 'All projects' },
    el('header', { className: 'rt-bar' }, el('div', { className: 'rt-bar-title' }, el('h3', {}, 'Projects'), el('p', { className: 'rt-muted rt-bar-meta' }, plural(list.length, 'project')))),
    el('ul', { className: 'rt-assets', 'aria-label': 'Projects' }, ...list.map(p => el('li', { key: p.id }, el('button', { type: 'button', className: 'rt-asset-card', disabled: busy, 'aria-label': `Open project ${p.name}`, title: p.name, onClick: () => switchProject(p.id) },
      h(Cover, { scope, project: p }), el('span', { className: 'rt-asset-text' }, el('strong', { className: 'rt-trunc' }, p.name)))))))
  const confirmDelete = () => {
    const sameProject = data && data.project.id === deleting.id
    const contents = sameProject ? [plural(assets.length, 'asset'), `${plural(versions.length, 'version')} and their media files`, data.annotations.length && plural(data.annotations.length, 'note'), data.briefs.length && plural(data.briefs.length, 'revision request'), attempts.length && plural(attempts.length, 'generation record')].filter(Boolean).join(', ') : 'all of its assets, versions, notes, revision requests and generation records'
    const blockedNow = sameProject && openAttempts > 0
    const close = () => { if (!busy) setDeleting(null) }
    return el('div', { key: 'delete', className: 'rt-overlay', onMouseDown: e => { if (e.target === e.currentTarget) close() }, onKeyDown: e => { if (e.key === 'Escape') close() } },
      el('div', { className: 'rt-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': `Delete project ${deleting.name}`, 'aria-describedby': 'retake-delete-body' },
        el('h2', {}, `Delete “${deleting.name}”?`),
        el('p', { id: 'retake-delete-body' }, `Permanently removes ${contents}. This can’t be undone.`),
        blockedNow ? el('p', { className: 'rt-dialog-error', role: 'status' }, 'A generation is in progress. Wait for it to finish before deleting.') : null,
        deleteError ? el('p', { className: 'rt-dialog-error', role: 'alert' }, deleteError) : null,
        el('div', { className: 'rt-row' },
          btn('Cancel', close, { disabled: busy, autoFocus: true }),
          btn(busy ? 'Deleting…' : 'Delete project', () => deleteProject(deleting), { variant: undefined, className: 'rt-danger', disabled: busy || blockedNow, 'aria-label': `Delete project ${deleting.name} permanently` }))))
  }
  let main
  if (!pid) main = projects.error ? emptyMain('pick', emptyBox({ kind: 'error', title: 'Projects unavailable', body: 'The Projects rail shows the reason.' }))
    : list.length ? projectGrid()
      : emptyMain('pick', projects.data ? emptyBox({ title: 'Create your first project', body: 'Name it in the Projects rail, then upload or generate a take.' })
        : emptyBox({ kind: 'loading', role: 'status', body: 'Loading projects…' }))
  else if (detail.error) main = emptyMain('error', emptyBox({ kind: 'error', role: 'alert', title: 'Could not load project', body: text(detail.error), actions: btn('Retry', () => detail.refetch()) }))
  else if (!data) main = emptyMain('loading', emptyBox({ kind: 'loading', role: 'status', body: 'Loading project…' }))
  else if (!versions.length) main = guide()
  else if (mode === 'compare') main = comparison
  else if (showOverview) main = overview()
  else if (selected) main = h(Review, { key: selected.id, scope, version: selected, versions, assetLabel: assetOf(selected)?.label || shortId(selected.asset_id), ordinalOf: ordinal, detail: data, act, busy, drafts, tab, setTab, fieldsOpen, setFieldsOpen, ...genProps, panel: null })
  else main = emptyMain('choose', emptyBox({ role: 'status', title: 'Choose a version', body: 'Pick a tile in the filmstrip below.' }))
  // New-asset generation borrows the inspector zone (beside or below the stage), never a modal or a third tab.
  const composerPanel = composer && data && mode === 'review' ? h(NewAssetPanel, { key: 'gen-new', gen, route, prompt: genPrompt, setPrompt: setGenPrompt, aspect: genAspect, setAspect: setGenAspect, model: genModel, setModel: setGenModel, picks,
    onGenerate: runGeneration, onClose: () => setComposer(false), generating, blocked: genBlocked, attempts: attempts.filter(a => a.kind === 'new_asset'), versions, onOpen: openVersion, onCheck: checkStatus, onSend: sendReserved, onCancel: cancelReserved }) : null
  if (composerPanel && mode === 'review' && selected && !showOverview) main = h(Review, { ...main.props, key: selected.id, panel: composerPanel })

  const frame = v => {
    const reviewing = mode === 'review' && v.id === active
    const chosen = compare.includes(v.id)
    return el('li', { key: v.id, className: 'rt-frame', 'data-active': reviewing ? 'true' : undefined, 'data-status': v.status },
      el('button', { type: 'button', className: 'rt-frame-btn', disabled: busy, 'aria-pressed': reviewing, 'aria-label': `Review ${v.name}`, title: `${v.name} · ${STATUS[v.status] || v.status} · ${lineage(v, versions)}`, onClick: () => navigateReview(v.id) },
        h(Thumb, { scope, version: v }),
        // Thumbnail, ordinal and status identify the take; the stored filename stays in the tooltip, details and download.
        el('span', { className: 'rt-frame-text' },
          el('span', { className: 'rt-frame-head' }, el('span', { className: 'rt-frame-v' }, ordinal(v)), status(v.status)))),
      el('label', { className: 'rt-check', title: chosen ? `Compare slot ${'AB'[compare.indexOf(v.id)]}` : compare.length >= 2 ? 'Two versions already chosen; untick one first' : 'Choose for Compare' },
        el('input', { type: 'checkbox', checked: chosen, disabled: !chosen && compare.length >= 2, onChange: e => toggleCompare(v.id, e.target.checked), 'aria-label': `Compare ${v.name}` }),
        el('span', { 'aria-hidden': 'true' }, chosen ? el('b', {}, 'AB'[compare.indexOf(v.id)]) : 'Compare')))
  }
  // A running attempt is shown as a placeholder tile, never as a version and never with a review status.
  const pendingTile = a => el('li', { key: `attempt-${a.id}`, className: 'rt-frame', 'data-attempt': a.state, title: `Generation attempt ${a.id}` },
    el('div', { className: 'rt-frame-btn' },
      el('span', { className: 'rt-thumb' }, a.state === 'reserved' ? 'Reserved…' : el('span', { className: 'rt-spin', 'aria-hidden': 'true' })),
      el('span', { className: 'rt-frame-text' },
        el('span', { className: 'rt-astate' }, a.state === 'reserved' ? 'Reserved' : 'Generating…'),
        el('span', { className: 'rt-frame-file' }, a.kind === 'revision' ? 'Revision attempt' : 'New asset attempt'),
        el('span', { className: 'rt-id' }, shortId(a.id)))))
  const pendingHere = runningAttempts.filter(a => a.kind === 'new_asset' || (asset && a.asset_id === asset.id))
  // Actions on the viewed version: its next version comes from a file here or from the Feedback panel's request.
  const canRevise = selected && selected.mime !== 'video/mp4' && gen.available && gen.revision
  const versionActions = selected ? [
    el('label', { key: 'up', className: 'rt-upload', 'data-disabled': busy ? 'true' : undefined, title: `Adds a version after ${ordinal(selected)}. PNG/JPEG/WebP ≤12 MB${VIDEO_UPLOADS ? ' · MP4 ≤32 MB, ≤120 s' : ''}.` }, icon(ICON.upload), el('span', {}, busy ? 'Saving…' : 'Upload next version'),
      el('input', { type: 'file', accept: UPLOAD_ACCEPT, disabled: busy, 'aria-label': 'Upload next version', onChange: e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) act({ path: `/projects/${enc(pid)}/versions?parent_id=${enc(selected.id)}`, file: f, after: v => review(v.id) }) } })),
    canRevise ? btn([icon(ICON.spark), el('span', { key: 't' }, 'Generate next version')], focusRevision, { key: 'gen', className: 'rt-gen-next', disabled: busy, title: `Describe the change in Feedback, then generate after ${ordinal(selected)}` }) : null] : []
  const strip = data && !showOverview && (asset || pendingHere.length > 0) && el('section', { key: 'strip', className: 'rt-strip', 'aria-label': 'Version filmstrip' },
    el('div', { className: 'rt-strip-main' },
      el('div', { className: 'rt-strip-head' },
        el('h3', { className: 'rt-strip-title' }, 'Versions', asset ? el('span', { className: 'rt-strip-count' }, asset.items.length) : null),
        assets.length > 1 ? el('span', { className: 'rt-muted' }, plural(assets.length, 'asset')) : null,
        // Compare is an action on two ticked versions, not a mode tab.
        compare.length === 1 ? el('span', { className: 'rt-muted' }, 'Tick one more to compare') : null,
        runningAttempts.length ? el('span', { className: 'rt-muted', role: 'status' }, `${runningAttempts[0].state === 'reserved' ? 'Reserved' : 'Generating'} · attempt ${shortId(runningAttempts[0].id)}`) : null,
        el('div', { className: 'rt-strip-actions' },
          compare.length === 2 && mode !== 'compare' ? btn(`Compare ${compare.map(id => ordinal(versions.find(v => v.id === id) || {}) || '?').join(' · ')}`, () => chooseMode('compare'), { variant: undefined, className: 'rt-compare-go', disabled: busy }) : null,
          ...versionActions)),
      el('ul', { className: 'rt-film' }, ...(asset ? asset.items.map(frame) : []), ...pendingHere.map(pendingTile))))

  const insp = composerPanel || (mode === 'review' && selected && !showOverview) ? 'open' : 'none'
  return el('main', { className: 'retake', 'aria-label': 'Retake creative review', 'data-tight': height > 0 && height < 480 ? 'true' : 'false', 'data-compact': height > 0 && (height < 1000 || dock === 'bottom') ? 'true' : 'false', ref: root }, h('style', { children: css }),
    header,
    message && el('div', { className: message.quiet ? 'rt-sr' : 'rt-notice', 'data-kind': message.kind, role: 'status', 'aria-live': 'polite' }, el('span', {}, message.head ? el('strong', {}, message.head) : message.kind === 'error' ? el('strong', {}, 'Not saved. ') : null, message.text), el('button', { type: 'button', className: 'rt-x', 'aria-label': 'Dismiss message', onClick: () => setMessage(null) }, '×')),
    el('div', { className: 'rt-shell', style: { '--rt-rail': `${railCollapsed ? RAIL_SHUT : RAIL_OPEN}px` } },
      rail,
      el('div', { className: 'rt-work', id: 'retake-work', 'data-dock': dock, 'data-insp': insp, 'data-mode': mode }, main, strip, composerPanel && (!selected || showOverview) ? composerPanel : null)),
    projectMenu(),
    deleting ? confirmDelete() : null)
}
function Root({ ctx }) {
  const profile = useValue(host.state.profile)
  const epoch = useGatewayActivationEpoch()
  return h(Workspace, { key: `${ctx.source}:${profile}:${epoch}`, ctx, profile, epoch })
}
export default {
  id: 'retake', name: 'Retake', defaultEnabled: false,
  register(ctx) {
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: '/retake' }, render: () => h(Root, { ctx }) })
    ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: '/retake', label: 'Retake', codicon: 'versions' } })
  }
}
