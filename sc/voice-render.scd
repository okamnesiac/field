// Renders a recorded take offline through an instrument's voice
// (keyboard-instrument.md §12), with the voicer the live voice host uses,
// so the take sounds as it was heard while it was played. Runs under the
// sc-render contract, plus the take:
//
// FIELD_INSTRUMENT  the instrument program, loaded under FIELD_MODE=voice
// FIELD_EVENTS      a JSON file: {"events": [[seconds, kind, ...], ...]},
//                   in time order, where kind is "on" (channel, note,
//                   velocity), "off" (channel, note), "cc" (channel,
//                   number, value), or "bend" (channel, value)
// FIELD_OUTPUT, FIELD_SAMPLE_RATE, FIELD_CHANNELS, FIELD_DURATION
(
var instrument = "FIELD_INSTRUMENT".getenv;
var eventsPath = "FIELD_EVENTS".getenv;
var out = "FIELD_OUTPUT".getenv;
var rate = "FIELD_SAMPLE_RATE".getenv.asInteger;
var chans = "FIELD_CHANNELS".getenv.asInteger;
var dur = "FIELD_DURATION".getenv.asFloat;
var voiceDef, loadError, take, score, voicer, now = 0.0, nextNode = 1000;

voiceDef = try { thisProcess.interpreter.executeFile(instrument) } { |error| loadError = error.errorString; nil };
case
{ loadError.notNil } {
	("ERROR: " ++ PathName(instrument).fileName ++ " does not answer FIELD_MODE=voice: " ++ loadError).postln;
	1.exit;
}
{ voiceDef.isKindOf(SynthDef).not } {
	("ERROR: " ++ PathName(instrument).fileName ++ " does not answer FIELD_MODE=voice: in voice mode its value must be a SynthDef").postln;
	1.exit;
}
{
	take = File.readAllString(eventsPath).parseJSON;
	score = Score.new;
	score.add([0.0, ['/d_recv', voiceDef.asBytes]]);

	voicer = thisProcess.interpreter.executeFile(PathName(thisProcess.nowExecutingPath).pathOnly +/+ "voicer.scd").(
		{ |note, velocity, freq|
			var node = nextNode;
			nextNode = nextNode + 1;
			score.add([now, [\s_new, voiceDef.name, node, 0, 0, \freq, freq, \amp, velocity / 127, \gate, 1, \out, 0]]);
			node
		},
		{ |node, freq| score.add([now, [\n_set, node, \freq, freq]]) },
		{ |node| score.add([now, [\n_set, node, \gate, 0]]) }
	);

	take["events"].do { |event|
		now = event[0].asFloat;
		switch (event[1].asString)
		{ "on" } { voicer.noteOn(event[2].asInteger, event[3].asInteger, event[4].asInteger) }
		{ "off" } { voicer.noteOff(event[2].asInteger, event[3].asInteger) }
		{ "cc" } { voicer.cc(event[2].asInteger, event[3].asInteger, event[4].asInteger) }
		{ "bend" } { voicer.bend(event[2].asInteger, event[3].asInteger) };
	};

	score.add([dur, [\c_set, 0, 0]]);
	score.recordNRT(
		outputFilePath: out,
		sampleRate: rate,
		headerFormat: "WAV",
		sampleFormat: "int24",
		options: ServerOptions.new.numOutputBusChannels_(chans),
		duration: dur,
		action: { 0.exit }
	);
};
)
