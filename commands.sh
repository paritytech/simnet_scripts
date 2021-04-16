

# run local test of what pipelines runs
docker run --volume /etc/gurke-container:/etc/gurke/  \
           docker.io/paritytech/simnetscripts:latest \
               gurke/scripts/run-test-environment-manager.sh  \
                  --test-script=../../simnet/testing/parachains/run_tests.sh \
                  --image="docker.io/paritypr/synth-wave:2714" \
                  --image-2="docker.io/paritypr/colander:2714"
