// The fixture plugin (plugin-hosting.md decision 12): the plugin the CI
// suite owns. Everything in it exists to make one hosting claim testable
// without a commercial plugin installed:
//
//   - deterministic by construction — no randomness, no denormal-prone
//     feedback, block-size invariant (per-sample arithmetic plus a fixed
//     delay line), so a hosted render can be byte-golden;
//   - reported latency the plugin actually exhibits (the delay line), so
//     the render path's latency trim is measurable;
//   - two parameters sharing the display name "Trim" with distinct
//     stable IDs, the collision decision 3's `Name#<id>` keys exist for;
//   - a state value (`offset`, a DC offset) that no parameter exposes,
//     so the blob-then-params restore order (decision 5) has something
//     only the blob can carry;
//   - a beat gate driven by the host playhead (decision 13): with no
//     position info the output is silence, so a render path that forgot
//     to supply transport context fails by bytes, not by hope.
//
// The state chunk is JSON on purpose — tests author blobs directly as
// files, hash them, and reference them from YAML, exercising the real
// file → setStateInformation path without an editor (chunk 3's job).

#include <juce_audio_processors/juce_audio_processors.h>

namespace
{
class FixtureProcessor final : public juce::AudioProcessor
{
public:
    FixtureProcessor()
        : juce::AudioProcessor (BusesProperties()
                                    .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                                    .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
    {
        addParameter (gain = new juce::AudioParameterFloat (
                          juce::ParameterID { "gain", 1 }, "Gain",
                          juce::NormalisableRange<float> (-24.0f, 24.0f), 0.0f,
                          juce::AudioParameterFloatAttributes().withLabel ("dB")));
        addParameter (trimA = new juce::AudioParameterFloat (
                          juce::ParameterID { "trimA", 1 }, "Trim",
                          juce::NormalisableRange<float> (-12.0f, 12.0f), 0.0f,
                          juce::AudioParameterFloatAttributes().withLabel ("dB")));
        addParameter (trimB = new juce::AudioParameterFloat (
                          juce::ParameterID { "trimB", 1 }, "Trim",
                          juce::NormalisableRange<float> (-12.0f, 12.0f), 0.0f,
                          juce::AudioParameterFloatAttributes().withLabel ("dB")));
        addParameter (latency = new juce::AudioParameterInt (
                          juce::ParameterID { "latency", 1 }, "Latency", 0, 512, 0,
                          juce::AudioParameterIntAttributes().withLabel ("samples")));
        addParameter (beatGate = new juce::AudioParameterBool (
                          juce::ParameterID { "beat", 1 }, "Beat Gate", false));

        // The capture hook: state blobs are captured, never hand-written
        // (plugin-hosting.md decision 7), so the test suite needs a way
        // to put non-param state *into* a capture. Renders never set
        // this variable; there the offset comes from the blob alone.
        const auto seeded = juce::SystemStats::getEnvironmentVariable ("FIELD_FIXTURE_OFFSET", "");
        if (seeded.isNotEmpty())
            stateOffset = seeded.getDoubleValue();
    }

    const juce::String getName() const override { return "Field Fixture"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    bool hasEditor() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }

    bool isBusesLayoutSupported (const BusesLayout& layouts) const override
    {
        const auto& in = layouts.getMainInputChannelSet();
        return in == layouts.getMainOutputChannelSet()
               && (in == juce::AudioChannelSet::mono() || in == juce::AudioChannelSet::stereo());
    }

    void prepareToPlay (double, int) override
    {
        // Latency is read here, once — the declared fixture behaviour.
        // Reacting to mid-session latency changes is decision 11's
        // drift story and lands with the editor chunk.
        delaySamples = latency->get();
        setLatencySamples (delaySamples);
        for (auto& line : delayLines)
        {
            line.assign (static_cast<size_t> (delaySamples), 0.0);
        }
        delayWrite = 0;
    }

    void releaseResources() override {}

    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        const auto numChannels = juce::jmin (buffer.getNumChannels(), 2);
        const auto numSamples = buffer.getNumSamples();
        const double gainLinear =
            std::pow (10.0, (double (gain->get()) + double (trimA->get()) + double (trimB->get())) / 20.0);

        // The beat gate is a pure function of the playhead: full level in
        // the first half of each beat, a quarter in the second. No
        // position info gates everything to silence — a host that forgot
        // the transport context should fail loudly in the bytes.
        double ppq = 0.0;
        double quartersPerSample = 0.0;
        bool havePosition = false;
        if (auto* playHead = getPlayHead())
        {
            if (auto position = playHead->getPosition())
            {
                if (position->getPpqPosition().hasValue() && position->getBpm().hasValue())
                {
                    ppq = *position->getPpqPosition();
                    quartersPerSample = *position->getBpm() / (60.0 * getSampleRate());
                    havePosition = true;
                }
            }
        }
        const bool gating = beatGate->get();

        for (int i = 0; i < numSamples; ++i)
        {
            double factor = 1.0;
            if (gating)
            {
                if (! havePosition)
                    factor = 0.0;
                else
                {
                    const double beatPhase = ppq + double (i) * quartersPerSample;
                    factor = (beatPhase - std::floor (beatPhase)) < 0.5 ? 1.0 : 0.25;
                }
            }

            for (int channel = 0; channel < numChannels; ++channel)
            {
                auto* data = buffer.getWritePointer (channel);
                double sample = double (data[i]) * gainLinear * factor + stateOffset;
                if (delaySamples > 0)
                {
                    auto& line = delayLines[static_cast<size_t> (channel)];
                    const double delayed = line[static_cast<size_t> (delayWrite)];
                    line[static_cast<size_t> (delayWrite)] = sample;
                    sample = delayed;
                }
                data[i] = static_cast<float> (sample);
            }
            if (delaySamples > 0)
                delayWrite = (delayWrite + 1) % delaySamples;
        }
    }

    void getStateInformation (juce::MemoryBlock& destData) override
    {
        auto* object = new juce::DynamicObject();
        object->setProperty ("gain", double (gain->get()));
        object->setProperty ("trimA", double (trimA->get()));
        object->setProperty ("trimB", double (trimB->get()));
        object->setProperty ("latency", latency->get());
        object->setProperty ("beat", beatGate->get());
        object->setProperty ("offset", stateOffset);
        const auto json = juce::JSON::toString (juce::var (object), true);
        destData.replaceAll (json.toRawUTF8(), json.getNumBytesAsUTF8());
    }

    void setStateInformation (const void* data, int sizeInBytes) override
    {
        const auto parsed =
            juce::JSON::parse (juce::String::fromUTF8 (static_cast<const char*> (data), sizeInBytes));
        if (! parsed.isObject())
            return;
        *gain = float (double (parsed.getProperty ("gain", 0.0)));
        *trimA = float (double (parsed.getProperty ("trimA", 0.0)));
        *trimB = float (double (parsed.getProperty ("trimB", 0.0)));
        *latency = int (parsed.getProperty ("latency", 0));
        *beatGate = bool (parsed.getProperty ("beat", false));
        stateOffset = double (parsed.getProperty ("offset", 0.0));
    }

private:
    juce::AudioParameterFloat* gain = nullptr;
    juce::AudioParameterFloat* trimA = nullptr;
    juce::AudioParameterFloat* trimB = nullptr;
    juce::AudioParameterInt* latency = nullptr;
    juce::AudioParameterBool* beatGate = nullptr;

    double stateOffset = 0.0;
    int delaySamples = 0;
    int delayWrite = 0;
    std::array<std::vector<double>, 2> delayLines;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (FixtureProcessor)
};
} // namespace

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new FixtureProcessor();
}
