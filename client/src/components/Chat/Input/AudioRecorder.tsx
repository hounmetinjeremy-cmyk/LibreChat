import { memo, useCallback, useEffect, useRef } from 'react';
import { Square } from 'lucide-react';
import { useWatch } from 'react-hook-form';
import { useRecoilValue } from 'recoil';
import {
  IconButton,
  useToastContext,
  TooltipAnchor,
  ListeningIcon,
  Spinner,
} from '@librechat/client';
import { useLocalize, useSpeechToText, useGetAudioSettings } from '~/hooks';
import { globalAudioId, type TAskFunction } from '~/common';
import { useChatFormContext } from '~/Providers';
import store from '~/store';

const isExternalSTT = (speechToTextEndpoint: string) => speechToTextEndpoint === 'external';

/** Animation des ondes : barres qui montent et descendent pendant l'écoute. */
const WAVE_KEYFRAMES =
  '@keyframes audio-wave{0%,100%{transform:scaleY(.25)}50%{transform:scaleY(1)}}';
const WAVE_DELAYS = [0, 0.15, 0.3, 0.1, 0.25, 0.05, 0.2];

export default memo(function AudioRecorder({
  disabled,
  ask,
  methods,
  isSubmitting,
}: {
  disabled: boolean;
  ask: TAskFunction;
  methods: ReturnType<typeof useChatFormContext>;
  isSubmitting: boolean;
}) {
  const { setValue, reset, getValues, control } = methods;
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { speechToTextEndpoint } = useGetAudioSettings();
  const speechSettingsInitialized = useRecoilValue(store.speechSettingsInitialized);
  const recorderDisabled = disabled || !speechSettingsInitialized;

  const existingTextRef = useRef<string>('');
  const isSubmittingRef = useRef(isSubmitting);
  isSubmittingRef.current = isSubmitting;

  const onTranscriptionComplete = useCallback(
    (text: string) => {
      if (isSubmittingRef.current) {
        showToast({
          message: localize('com_ui_speech_while_submitting'),
          status: 'error',
        });
        return;
      }
      if (text) {
        const globalAudio = document.getElementById(globalAudioId) as HTMLAudioElement | null;
        if (globalAudio) {
          console.log('Unmuting global audio');
          globalAudio.muted = false;
        }
        /** For external STT, append existing text to the transcription */
        const finalText =
          isExternalSTT(speechToTextEndpoint) && existingTextRef.current
            ? `${existingTextRef.current} ${text}`
            : text;
        const submitted = ask({ text: finalText });
        if (submitted === false) {
          return;
        }
        reset({ text: '' });
        existingTextRef.current = '';
      }
    },
    [ask, reset, showToast, localize, speechToTextEndpoint],
  );

  const setText = useCallback(
    (text: string) => {
      let newText = text;
      if (isExternalSTT(speechToTextEndpoint)) {
        /** For external STT, the text comes as a complete transcription, so append to existing */
        newText = existingTextRef.current ? `${existingTextRef.current} ${text}` : text;
      } else {
        /** For browser STT, the transcript is cumulative, so we only need to prepend the existing text once */
        newText = existingTextRef.current ? `${existingTextRef.current} ${text}` : text;
      }
      setValue('text', newText, {
        shouldValidate: true,
      });
    },
    [setValue, speechToTextEndpoint],
  );

  const { isListening, isLoading, startRecording, stopRecording, clearTranscript } =
    useSpeechToText(setText, onTranscriptionComplete);

  const handleStartRecording = useCallback(() => {
    existingTextRef.current = getValues('text') || '';
    startRecording();
  }, [getValues, startRecording]);

  const handleStopRecording = useCallback(() => {
    stopRecording();
    /** For browser STT, clear the reference since text was already being updated */
    if (!isExternalSTT(speechToTextEndpoint)) {
      existingTextRef.current = '';
    }
  }, [speechToTextEndpoint, stopRecording]);

  /**
   * Quand le message est envoyé, le champ de saisie est vidé : on efface alors la dictée
   * mémorisée par le micro, sinon le texte déjà envoyé revient dans le champ.
   */
  const currentText = useWatch({ control, name: 'text' });
  const previousTextRef = useRef<string>('');
  useEffect(() => {
    const previousText = previousTextRef.current;
    previousTextRef.current = currentText || '';
    if (
      isListening === true &&
      !isExternalSTT(speechToTextEndpoint) &&
      previousText !== '' &&
      !currentText
    ) {
      clearTranscript();
      existingTextRef.current = '';
    }
  }, [clearTranscript, currentText, isListening, speechToTextEndpoint]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || !event.altKey || event.code !== 'KeyL' || recorderDisabled) {
        return;
      }

      event.preventDefault();
      if (isListening === true) {
        handleStopRecording();
        return;
      }

      handleStartRecording();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleStartRecording, handleStopRecording, isListening, recorderDisabled]);

  const renderIcon = () => {
    if (isListening === true) {
      /** Pendant l'écoute : ondes animées + bouton carré d'arrêt (comme dans l'app Claude) */
      return (
        <span className="flex items-center gap-2 px-1">
          <style>{WAVE_KEYFRAMES}</style>
          <span className="flex h-5 items-center gap-[3px]" aria-hidden="true">
            {WAVE_DELAYS.map((delay, index) => (
              <span
                key={index}
                className="h-5 w-[3px] rounded-full bg-text-primary"
                style={{ animation: `audio-wave 0.9s ease-in-out ${delay}s infinite` }}
              />
            ))}
          </span>
          <span className="flex size-7 items-center justify-center rounded-full bg-surface-tertiary">
            <Square className="size-3 fill-current stroke-current text-text-primary" />
          </span>
        </span>
      );
    }
    if (isLoading === true) {
      return <Spinner className="stroke-text-secondary" />;
    }
    return <ListeningIcon className="stroke-text-secondary" />;
  };

  return (
    <TooltipAnchor
      description={localize('com_ui_use_micrphone')}
      render={
        <IconButton
          id="audio-recorder"
          type="button"
          variant="ghost"
          size="theme"
          shape="theme"
          label={localize('com_ui_use_micrphone')}
          onClick={isListening === true ? handleStopRecording : handleStartRecording}
          disabled={recorderDisabled}
          className="p-1 hover:bg-surface-composer-hover"
          aria-pressed={isListening}
        >
          {renderIcon()}
        </IconButton>
      }
    />
  );
});
