import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { markStyleGender, type MarkGender, type MarkMaterial, type MarkShape, type MarkStyle } from "@nano-agents/shared";
import { ShapeGlyph } from "./ShapeGlyph";
import { colors } from "../theme/tokens";

const studioModule = require("../../assets/dot-avatar-maker.html") as number;

/** Big marks are a live WebGL view. Smaller ones share one baker and show its PNG. */
const LIVE_AT = 64;

type Job = {
  shape: string;
  color: string;
  material: string;
  style: MarkStyle;
  gender: MarkGender;
};

const STYLE_GENDER_JSON = JSON.stringify(markStyleGender);

let htmlCache: Promise<string> | null = null;
export function studioHtml(): Promise<string> {
  if (!htmlCache) {
    htmlCache = (async () => {
      const asset = Asset.fromModule(studioModule);
      await asset.downloadAsync();
      const uri = asset.localUri ?? asset.uri;
      if (!uri) throw new Error("Dot studio asset missing");
      return new File(uri).text();
    })();
  }
  return htmlCache;
}

// Warm the bundled studio as soon as this module loads.
void studioHtml();

function boot(job: Job, motion: boolean): string {
  const view = { ...job, motion };
  return `window.DOT_VIEW=${JSON.stringify(view)};window.DOT_MARK=true;`;
}

function apply(job: Job): string {
  const { shape, color, material, style, gender } = job;
  return `(function(){
    var d=window.__dot; if(!d) return false;
    var g=${JSON.stringify(gender)};
    var st=${JSON.stringify(style)};
    if(d.state.gender!==g) d.state.gender=g;
    var map=${STYLE_GENDER_JSON};
    function fits(id,gg){
      var sg=map[id];
      if(!sg) return true;
      return sg===(gg==='female'?'f':'m');
    }
    if(!fits(st,g)) st= g==='female'?'lady':'gentleman';
    d.setOption('shape',${JSON.stringify(shape)});
    d.setOption('material',${JSON.stringify(material)});
    d.setOption('style',st);
    d.setColor(${JSON.stringify(color)});
    return true;
  })()`;
}

/** Live preview: rebuild in-page, then ping RN after the mesh settles (paint only fires once at boot). */
function applyLive(job: Job): string {
  return `${apply(job)};
    setTimeout(function(){
      try{ if(window.__dot&&window.__dot.main) window.__dot.main.render(); }catch(e){}
      if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({type:'paint'}));
    }, 320);
    true;`;
}

const cache = new Map<string, string>();
const waiters = new Map<string, Array<(url: string | null) => void>>();
const jobs = new Map<string, Job>();
const order: string[] = [];
let web: WebView | null = null;
let studioReady = false;
let inflight: string | null = null;

function keyOf(job: Job): string {
  return `${job.shape}|${job.color.toUpperCase()}|${job.material}|${job.style}|${job.gender}`;
}

function pump(): void {
  if (!studioReady || !web || inflight) return;
  const key = order.find((item) => waiters.has(item) && !cache.has(item));
  if (!key) return;
  const job = jobs.get(key);
  if (!job) return;
  inflight = key;
  web.injectJavaScript(`${apply(job)};
    setTimeout(function(){
      var url=null; try{ url=window.__dot&&window.__dot.snapshot(320); }catch(e){}
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'shot',key:${JSON.stringify(key)},url:url}));
    }, 280);
    true;`);
}

function enqueue(job: Job, done: (url: string | null) => void): () => void {
  const key = keyOf(job);
  const hit = cache.get(key);
  if (hit) {
    done(hit);
    return () => {};
  }
  const list = waiters.get(key) ?? [];
  list.push(done);
  waiters.set(key, list);
  if (!jobs.has(key)) {
    jobs.set(key, job);
    order.push(key);
  }
  pump();
  return () => {
    const next = (waiters.get(key) ?? []).filter((fn) => fn !== done);
    if (next.length) waiters.set(key, next);
    else waiters.delete(key);
  };
}

function onBakeryMessage(event: WebViewMessageEvent): void {
  let msg: { type?: string; key?: string; url?: string | null } = {};
  try {
    msg = JSON.parse(event.nativeEvent.data) as typeof msg;
  } catch {
    return;
  }
  if (msg.type === "ready") {
    studioReady = true;
    pump();
    return;
  }
  if (msg.type !== "shot" || !msg.key || msg.key !== inflight) return;
  if (msg.url) {
    cache.set(msg.key, msg.url);
    if (cache.size > 64) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
  }
  const pending = waiters.get(msg.key) ?? [];
  waiters.delete(msg.key);
  inflight = null;
  for (const fn of pending) fn(msg.url ?? null);
  pump();
}

/** One studio WebView that bakes transparent PNGs for small marks. */
export function DotBakery() {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    studioHtml()
      .then((text) => {
        if (alive) setHtml(text);
      })
      .catch(() => {});
    return () => {
      alive = false;
      studioReady = false;
      web = null;
      inflight = null;
    };
  }, []);

  if (!html) return null;
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", width: 200, height: 200, left: 0, top: 0, opacity: 0.01, zIndex: -1 }}
    >
      <WebView
        ref={(node) => {
          web = node;
        }}
        source={{ html, baseUrl: "https://cdn.jsdelivr.net/" }}
        injectedJavaScriptBeforeContentLoaded={boot(
          { shape: "cloud", color: "#FFCC38", material: "plush", style: "gentleman", gender: "male" },
          false,
        )}
        injectedJavaScript={`(function wait(){ if(window.__dot&&window.__dot.snapshot){ window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'})); } else setTimeout(wait, 120); })(); true;`}
        onMessage={onBakeryMessage}
        originWhitelist={["*"]}
        scrollEnabled={false}
        mediaPlaybackRequiresUserAction={false}
        style={{ width: 200, height: 200, backgroundColor: "transparent" }}
        containerStyle={{ backgroundColor: "transparent" }}
      />
    </View>
  );
}

/** Still image of the real Dot character (same mesh + material as the hero). */
export function DotThumb({
  shape,
  color,
  material,
  style = "gentleman",
  gender = "male",
  size,
}: {
  shape: MarkShape;
  color: string;
  material: MarkMaterial;
  style?: MarkStyle;
  gender?: MarkGender;
  size: number;
}) {
  const [url, setUrl] = useState<string | null>(() => cache.get(keyOf({ shape, color, material, style, gender })) ?? null);
  const shapeRef = useRef(shape);

  useEffect(() => {
    const job = { shape, color, material, style, gender };
    const hit = cache.get(keyOf(job));
    if (hit) {
      setUrl(hit);
      shapeRef.current = shape;
      return;
    }
    // Only drop to the flat glyph when the form changes; keep the last 3D PNG while color/material rebake.
    if (shapeRef.current !== shape) {
      setUrl(null);
      shapeRef.current = shape;
    }
    let active = true;
    const stop = enqueue(job, (next) => {
      if (active && next) setUrl(next);
    });
    return () => {
      active = false;
      stop();
    };
  }, [shape, color, material, style, gender]);

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {url ? (
        <Image source={{ uri: url }} style={{ width: size, height: size }} contentFit="contain" />
      ) : (
        <ShapeGlyph shape={shape} color={color} size={size} />
      )}
    </View>
  );
}

/** Live Dot studio viewer. Glyph stays on top until the first 3D frame (no white flash). */
export function DotLive({
  shape,
  color,
  material,
  style = "gentleman",
  gender = "male",
  size,
}: {
  shape: MarkShape;
  color: string;
  material: MarkMaterial;
  style?: MarkStyle;
  gender?: MarkGender;
  size: number;
}) {
  const ref = useRef<WebView>(null);
  const ready = useRef(false);
  const jobRef = useRef({ shape, color, material, style, gender });
  jobRef.current = { shape, color, material, style, gender };
  const [html, setHtml] = useState<string | null>(null);
  /** Flat glyph only covers the first boot — never again when shape/color/material change. */
  const [bootCover, setBootCover] = useState(true);
  const [glVisible, setGlVisible] = useState(false);

  useEffect(() => {
    let alive = true;
    studioHtml()
      .then((text) => {
        if (alive) setHtml(text);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!ready.current) return;
    ref.current?.injectJavaScript(applyLive(jobRef.current));
  }, [shape, color, material, style, gender]);

  function onLiveMessage(event: WebViewMessageEvent): void {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as { type?: string };
      if (msg.type === "paint") {
        setBootCover(false);
        setGlVisible(true);
      }
    } catch {
      /* ignore */
    }
  }

  return (
    <View style={{ width: size, height: size, backgroundColor: colors.bg }}>
      {bootCover ? (
        <View style={[StyleSheet.absoluteFill, styles.glyphCenter]}>
          <ShapeGlyph shape={shape} color={color} size={size * 0.72} />
        </View>
      ) : null}
      {html ? (
        <WebView
          ref={ref}
          source={{ html, baseUrl: "https://cdn.jsdelivr.net/" }}
          injectedJavaScriptBeforeContentLoaded={boot(jobRef.current, true)}
          onLoadEnd={() => {
            ready.current = true;
            ref.current?.injectJavaScript(applyLive(jobRef.current));
          }}
          onMessage={onLiveMessage}
          originWhitelist={["*"]}
          scrollEnabled={false}
          bounces={false}
          style={{
            width: size,
            height: size,
            backgroundColor: "transparent",
            opacity: glVisible ? 1 : 0,
          }}
          containerStyle={{ backgroundColor: "transparent" }}
        />
      ) : null}
    </View>
  );
}

export function isLiveMark(size: number): boolean {
  return size >= LIVE_AT;
}

const styles = StyleSheet.create({
  glyphCenter: { alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
});
