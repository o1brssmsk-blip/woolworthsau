"use client";

import type { ActiveWheelLayout, WheelSceneKey } from "@/app/wheel/wheel-layout";

type Props = {
  layout: ActiveWheelLayout;
  rotation: number;
  spinning: boolean;
  disabled: boolean;
  onSpin: () => void;
  onSpinEnd: () => void;
};

const WHEEL_ASSETS: Record<
  WheelSceneKey,
  {
    backgroundSrc: string;
    wheelSrc: string;
    frameSrc: string;
    pointerSrc: string;
    buttonSrc: string;
    centerHubSrc: string;
    
    // Exact positioning from provided style.css
    wheelLeft: string;
    wheelTop: string;
    wheelWidth: string;
    wheelHeight: string;
    wheelTransformOrigin: string;

    hubLeft: string;
    hubTop: string;
    hubWidth: string;
    hubHeight: string;

    pointerLeft: string;
    pointerTop: string;
    pointerWidth: string;
    pointerHeight: string;

    buttonLeft: string;
    buttonTop: string;
    buttonWidth: string;
    buttonHeight: string;
  }
> = {
  desktop: {
    backgroundSrc: "/wheel-assets/desktop/background-opaque.png",
    wheelSrc: "/wheel-assets/desktop/png/wheel-with-aud-labels.png",
    frameSrc: "/wheel-assets/desktop/png/wheel-frame.png",
    pointerSrc: "/wheel-assets/desktop/png/pointer.png",
    buttonSrc: "/wheel-assets/desktop/png/spin-now-button.png",
    centerHubSrc: "/wheel-assets/desktop/png/woolworths-logo-hub.png",

    wheelLeft: "27.1531%",
    wheelTop: "5.9511%",
    wheelWidth: "45.4545%",
    wheelHeight: "80.7651%",
    wheelTransformOrigin: "50.1316% 51.7105%",

    hubLeft: "42.0455%",
    hubTop: "33.6876%",
    hubWidth: "15.7895%",
    hubHeight: "28.0553%",

    pointerLeft: "46.1722%",
    pointerTop: "5.6323%",
    pointerWidth: "7.5359%",
    pointerHeight: "11.1583%",

    buttonLeft: "33.1938%",
    buttonTop: "83.9532%",
    buttonWidth: "33.6722%",
    buttonHeight: "14.5589%",
  },
  mobile: {
    backgroundSrc: "/wheel-assets/mobile/background-opaque.png",
    wheelSrc: "/wheel-assets/mobile/png/wheel-with-aud-labels.png",
    frameSrc: "/wheel-assets/mobile/png/wheel-frame.png",
    pointerSrc: "/wheel-assets/mobile/png/pointer.png",
    buttonSrc: "/wheel-assets/mobile/png/spin-now-button.png",
    centerHubSrc: "/wheel-assets/mobile/png/woolworths-logo-hub.png",

    wheelLeft: "7.86397%",
    wheelTop: "20.39474%",
    wheelWidth: "84.16578%",
    wheelHeight: "47.36842%",
    wheelTransformOrigin: "50% 48.35859%",

    hubLeft: "35.91923%",
    hubTop: "35.40670%",
    hubWidth: "28.05526%",
    hubHeight: "15.78947%",

    pointerLeft: "43.14559%",
    pointerTop: "17.70335%",
    pointerWidth: "13.39001%",
    pointerHeight: "5.80144%",

    buttonLeft: "20.82997%",
    buttonTop: "78.70813%",
    buttonWidth: "58.34219%",
    buttonHeight: "8.25359%",
  },
};

export function AlbertHeijnWheel({ layout, rotation, spinning, disabled, onSpin, onSpinEnd }: Props) {
  const scene = layout.scene;
  const assets = WHEEL_ASSETS[layout.sceneKey];

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div
        className="relative flex h-full w-full items-center justify-center overflow-hidden"
        style={{
          padding: "12px",
          boxSizing: "border-box",
          contain: "layout paint size",
          transform: "translateZ(0)",
        }}
      >
        <div
          className="relative overflow-hidden"
          style={{
            width: layout.stageStyle.width,
            height: layout.stageStyle.height,
            maxWidth: "100%",
            maxHeight: "100%",
            aspectRatio: scene.aspectRatio,
            contain: "layout paint size",
            transform: "translateZ(0)",
            WebkitTransform: "translateZ(0)",
            borderRadius: "4px",
            isolation: "isolate",
          }}
        >
          {/* 1. BACKGROUND */}
          <img
            src={assets.backgroundSrc}
            alt={layout.sceneKey === "desktop" ? "Desktop prize wheel background" : "Mobile prize wheel background"}
            className="pointer-events-none absolute inset-0 z-[1] h-full w-full select-none object-fill"
            draggable={false}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            style={{
              transform: "translateZ(0)",
              WebkitTransform: "translateZ(0)",
              backfaceVisibility: "hidden",
              imageRendering: "auto",
            }}
          />

          {/* 2. ROTATING WHEEL */}
          <div
            className="pointer-events-none absolute z-[2] will-change-transform"
            style={{
              left: assets.wheelLeft,
              top: assets.wheelTop,
              width: assets.wheelWidth,
              height: assets.wheelHeight,
              // Tam merkez noktasına sabitle: hassas ondalık yüzdelik → alt piksel hesaplamayı azalt
              transformOrigin: layout.sceneKey === "desktop"
                ? "50.125% 51.75%"
                : "50% 48.375%",
              transform: `translate3d(0,0,0) rotate(${rotation}deg)`,
              WebkitTransform: `translate3d(0,0,0) rotate(${rotation}deg)`,
              // ⭐ NEW ZELLAND (eski proje) ile BIRBIR AYNI spin hissi:
              //   - Toplam sure: 5000ms (5 saniye)
              //   - Tam tur: MIN_FULL_SPINS=6 (wheel-client.tsx icinde)
              //   - Easing: cubic-bezier(.12,.8,.18,1): ilk 12% hafif ivme (0.8 max
              //     hiz), sonra 18% kontrol (lineer akis), son 40% dogal yavaslama.
              //   - Sonuc: kullanıcı her segmenti GOREBILIR, nerede duracagini anlar
              //     (eski AUD 20 saniye 8 tur cok hizli akip segmentler secilemiyordu)
              transition: spinning
                ? "transform 5000ms cubic-bezier(.12,.8,.18,1)"
                : "none",
              backfaceVisibility: "hidden",
              WebkitBackfaceVisibility: "hidden",
              imageRendering: "auto",
              contain: "layout paint size",
            }}
            onTransitionEnd={onSpinEnd}
          >
            <img
              src={assets.wheelSrc}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="h-full w-full select-none object-fill"
              loading="eager"
              decoding="async"
              fetchPriority="high"
              style={{
                transform: "translate3d(0,0,0)",
                WebkitTransform: "translate3d(0,0,0)",
                backfaceVisibility: "hidden",
                imageRendering: "auto",
                pointerEvents: "none",
              }}
            />
          </div>

          {/* 3. STATIC FRAME (ZORUNLU: DÖNEN WHEEL İLE AYNI GPU KATMANINDA) */}
          <img
            src={assets.frameSrc}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="pointer-events-none absolute z-[3] select-none object-fill"
            loading="eager"
            decoding="async"
            style={{
              left: assets.wheelLeft,
              top: assets.wheelTop,
              width: assets.wheelWidth,
              height: assets.wheelHeight,
              transform: "translate3d(0,0,0)",
              WebkitTransform: "translate3d(0,0,0)",
              backfaceVisibility: "hidden",
              WebkitBackfaceVisibility: "hidden",
              imageRendering: "auto",
              contain: "layout paint size",
            }}
          />

          {/* 4. STATIC CENTER HUB (AYNI GPU KATMANI) */}
          <img
            src={assets.centerHubSrc}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="pointer-events-none absolute z-[4] select-none object-fill"
            loading="eager"
            decoding="async"
            style={{
              left: assets.hubLeft,
              top: assets.hubTop,
              width: assets.hubWidth,
              height: assets.hubHeight,
              transform: "translate3d(0,0,0)",
              WebkitTransform: "translate3d(0,0,0)",
              backfaceVisibility: "hidden",
              imageRendering: "auto",
              contain: "layout paint size",
            }}
          />

          {/* 5. STATIC POINTER (AYNI GPU KATMANI) */}
          <img
            src={assets.pointerSrc}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="pointer-events-none absolute z-[5] select-none object-fill"
            loading="eager"
            decoding="async"
            style={{
              left: assets.pointerLeft,
              top: assets.pointerTop,
              width: assets.pointerWidth,
              height: assets.pointerHeight,
              transform: "translate3d(0,0,0)",
              WebkitTransform: "translate3d(0,0,0)",
              backfaceVisibility: "hidden",
              imageRendering: "auto",
              contain: "layout paint size",
            }}
          />

          {/* 6. BUTTON HIGHLIGHT GLOW */}
          <div
            className={`pointer-events-none absolute z-[6] transition-all duration-300 ${spinning ? "bg-white/10 shadow-[0_0_36px_rgba(255,255,255,0.28)]" : "bg-transparent"}`}
            style={{
              left: assets.buttonLeft,
              top: assets.buttonTop,
              width: assets.buttonWidth,
              height: assets.buttonHeight,
              borderRadius: "100px",
              transform: "translateZ(0)",
              backfaceVisibility: "hidden",
            }}
          />

          {/* 7. STATIC BUTTON ART */}
          <img
            src={assets.buttonSrc}
            alt=""
            aria-hidden="true"
            draggable={false}
            className={`pointer-events-none absolute z-[7] select-none transition-transform duration-200 object-fill ${disabled ? "opacity-90" : "opacity-100"}`}
            loading="eager"
            decoding="async"
            style={{
              left: assets.buttonLeft,
              top: assets.buttonTop,
              width: assets.buttonWidth,
              height: assets.buttonHeight,
              transform: "translate3d(0,0,0)",
              WebkitTransform: "translate3d(0,0,0)",
              backfaceVisibility: "hidden",
              imageRendering: "auto",
              contain: "layout paint size",
            }}
          />

          {/* CLICKABLE HIT AREA */}
          <button
            type="button"
            onClick={onSpin}
            disabled={disabled}
            aria-label="Spin the prize wheel"
            className="absolute z-[8] bg-transparent focus:outline-none focus-visible:ring-4 focus-visible:ring-white/80 disabled:cursor-not-allowed"
            style={{
              left: assets.buttonLeft,
              top: assets.buttonTop,
              width: assets.buttonWidth,
              height: assets.buttonHeight,
              touchAction: "manipulation",
              borderRadius: "100px",
              transform: "translateZ(0)",
            }}
          >
            <span className="sr-only">{spinning ? "Spinning" : "Spin now"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
