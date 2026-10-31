import { useCallback, useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';
import { useToastContext } from '@librechat/client';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import SpeechRecognitionImport, { useSpeechRecognition } from 'react-speech-recognition';
import { useLocalize } from '~/hooks';
import store from '~/store';

type SpeechRecognitionController = Pick<
  typeof SpeechRecognitionImport,
  'startListening' | 'stopListening'
> &
  Partial<Pick<typeof SpeechRecognitionImport, 'abortListening'>>;
type SpeechRecognitionModule = Partial<SpeechRecognitionController> & {
  default?: Partial<SpeechRecognitionController>;
};

const hasSpeechRecognitionController = (
  controller?: Partial<SpeechRecognitionController>,
): controller is SpeechRecognitionController =>
  typeof controller?.startListening === 'function' &&
  typeof controller.stopListening === 'function';

const speechRecognitionModule = SpeechRecognitionImport as SpeechRecognitionModule;
const SpeechRecognition = hasSpeechRecognitionController(speechRecognitionModule)
  ? speechRecognitionModule
  : speechRecognitionModule.default;

/** Relance automatique : délai avant de relancer, et limite anti-boucle (4 relances en 5 s). */
const RESTART_DELAY_MS = 300;
const RESTART_WINDOW_MS = 5000;
const RESTART_MAX_IN_WINDOW = 4;

const useSpeechToTextBrowser = (
  setText: (text: string) => void,
  onTranscriptionComplete: (text: string) => void,
) => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: speechConfig } = useGetCustomConfigSpeechQuery({ enabled: true });
  const sttExternal = Boolean(speechConfig?.sttExternal);

  const lastTranscript = useRef<string | null>(null);
  const lastInterim = useRef<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>();
  /** Vrai tant que la personne n'a pas appuyé sur le carré : le micro doit rester allumé. */
  const wantsListeningRef = useRef(false);
  const restartTimesRef = useRef<number[]>([]);
  const [autoSendText] = useRecoilState(store.autoSendText);
  const [languageSTT] = useRecoilState<string>(store.languageSTT);
  const [autoTranscribeAudio] = useRecoilState<boolean>(store.autoTranscribeAudio);

  const {
    listening,
    finalTranscript,
    resetTranscript,
    interimTranscript,
    isMicrophoneAvailable,
    browserSupportsSpeechRecognition,
  } = useSpeechRecognition();
  const isListening = listening;

  useEffect(() => {
    if (interimTranscript == null || interimTranscript === '') {
      return;
    }

    if (lastInterim.current === interimTranscript) {
      return;
    }

    setText(interimTranscript);
    lastInterim.current = interimTranscript;
  }, [setText, interimTranscript]);

  useEffect(() => {
    if (finalTranscript == null || finalTranscript === '') {
      return;
    }

    if (lastTranscript.current === finalTranscript) {
      return;
    }

    setText(finalTranscript);
    lastTranscript.current = finalTranscript;
    if (autoSendText > -1 && finalTranscript.length > 0) {
      timeoutRef.current = setTimeout(() => {
        onTranscriptionComplete(finalTranscript);
        resetTranscript();
      }, autoSendText * 1000);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [setText, onTranscriptionComplete, resetTranscript, finalTranscript, autoSendText]);

  /**
   * Chrome coupe parfois l'écoute tout seul (silence, changement d'application, réseau).
   * Si la personne n'a pas appuyé sur le carré, on relance le micro sans effacer le texte.
   * Sécurité : au plus 4 relances en 5 secondes, sinon on abandonne (pas de boucle infinie).
   */
  useEffect(() => {
    if (isListening === true || !wantsListeningRef.current) {
      return;
    }
    if (!autoTranscribeAudio || !isMicrophoneAvailable) {
      wantsListeningRef.current = false;
      return;
    }
    if (!hasSpeechRecognitionController(SpeechRecognition)) {
      return;
    }

    const now = Date.now();
    restartTimesRef.current = restartTimesRef.current.filter((t) => now - t < RESTART_WINDOW_MS);
    if (restartTimesRef.current.length >= RESTART_MAX_IN_WINDOW) {
      wantsListeningRef.current = false;
      return;
    }
    restartTimesRef.current.push(now);

    const restartTimer = setTimeout(() => {
      if (wantsListeningRef.current && hasSpeechRecognitionController(SpeechRecognition)) {
        SpeechRecognition.startListening({
          language: languageSTT,
          continuous: autoTranscribeAudio,
        });
      }
    }, RESTART_DELAY_MS);

    return () => clearTimeout(restartTimer);
  }, [autoTranscribeAudio, isListening, isMicrophoneAvailable, languageSTT]);

  /** Si le composant disparaît, le micro ne doit plus se relancer. */
  useEffect(
    () => () => {
      wantsListeningRef.current = false;
    },
    [],
  );

  /** Oublie tout ce qui a été dicté (sinon le texte déjà envoyé revient dans le champ de saisie). */
  const clearTranscript = useCallback(() => {
    wantsListeningRef.current = false;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    if (isListening === true) {
      if (SpeechRecognition?.abortListening) {
        void SpeechRecognition.abortListening();
      } else {
        void SpeechRecognition?.stopListening?.();
      }
    }
    resetTranscript();
    lastTranscript.current = null;
    lastInterim.current = null;
  }, [isListening, resetTranscript]);

  const toggleListening = useCallback(() => {
    if (!browserSupportsSpeechRecognition) {
      showToast({
        message: sttExternal
          ? localize('com_ui_speech_not_supported_use_external')
          : localize('com_ui_speech_not_supported'),
        status: 'error',
      });
      return;
    }

    if (!isMicrophoneAvailable) {
      showToast({
        message: localize('com_ui_microphone_unavailable'),
        status: 'error',
      });
      return;
    }

    if (!hasSpeechRecognitionController(SpeechRecognition)) {
      showToast({
        message: sttExternal
          ? localize('com_ui_speech_not_supported_use_external')
          : localize('com_ui_speech_not_supported'),
        status: 'error',
      });
      return;
    }

    if (isListening === true) {
      wantsListeningRef.current = false;
      SpeechRecognition.stopListening();
    } else {
      /** Nouvelle dictée : on repart de zéro pour ne pas réinjecter l'ancien texte. */
      resetTranscript();
      lastTranscript.current = null;
      lastInterim.current = null;
      restartTimesRef.current = [];
      wantsListeningRef.current = true;
      SpeechRecognition.startListening({
        language: languageSTT,
        continuous: autoTranscribeAudio,
      });
    }
  }, [
    autoTranscribeAudio,
    browserSupportsSpeechRecognition,
    isListening,
    isMicrophoneAvailable,
    languageSTT,
    localize,
    resetTranscript,
    showToast,
    sttExternal,
  ]);

  return {
    isListening,
    isLoading: false,
    startRecording: toggleListening,
    stopRecording: toggleListening,
    clearTranscript,
  };
};

export default useSpeechToTextBrowser;
